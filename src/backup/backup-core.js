'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');

const { pool } = require('../db/pool');
const TABLES = require('./tables');

const BACKUP_ROOT = process.env.BACKUP_DIR || '/app/backups';
const KEEP = Number(process.env.BACKUP_KEEP || 8);

// Tabelle con dati di un singolo utente (tutte tranne `users`) — usate per
// il backup/ripristino per-utente (vedi restore-user.js).
const USER_SCOPED_TABLES = TABLES.filter((t) => t.columns.includes('user_id'));

// Il nome di una cartella di backup finisce con il timestamp: AAAA-MM-GG_hh-mm-ss
// (backup vecchi) o con i millisecondi in più (-mmm). L'ordine cronologico si
// ricava da lì, non dal nome intero: nei backup personali lo slug dell'utente
// precede il timestamp e può cambiare. Non si usa una lunghezza fissa: i backup
// vecchi hanno 19 caratteri di timestamp, i nuovi 23.
const TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-(\d{3}))?$/;
function backupSortKey(name) {
  const m = TIMESTAMP_RE.exec(name);
  return m ? `${m[1]}-${m[2] ?? '000'}` : name;
}
const byTimestamp = (a, b) => backupSortKey(a).localeCompare(backupSortKey(b)) || a.localeCompare(b);

// Cartelle 0700 e file 0600 (il backup globale contiene password_hash, tutti
// contengono dati finanziari). Il chmod esplicito vale anche con una umask
// permissiva.
function secureMkdir(dir) {
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
function secureWrite(file, data) {
  fs.writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Esegue fn(client) in una transazione REPEATABLE READ di sola lettura: tutte le
 * tabelle del backup vengono lette dallo stesso istante, anche con scritture
 * concorrenti (altrimenti movimenti e categorie potrebbero non corrispondere).
 */
async function withSnapshot(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Millisecondi inclusi (non solo i secondi) per evitare che due backup dello
// stesso utente nello stesso secondo (due chiamate CLI ravvicinate, o un cron
// e una chiamata manuale che si sovrappongono) finiscano nella stessa cartella.
function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
}

// Parte leggibile del nome della cartella di backup: la parte prima della @
// (o l'intero identificativo, se non è un'email), pulita per essere un nome
// di cartella sicuro. L'id resta comunque nel prefisso (userBackupPrefix) per
// garantire l'unicità: due utenti possono avere la stessa parte locale con
// domini diversi.
function usernameSlug(email) {
  const local = String(email || '').split('@')[0] || 'utente';
  return local.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40) || 'utente';
}

function writeTableCsv(dir, table, rows) {
  const csv = stringify(rows, {
    header: true,
    columns: table.columns,
    cast: {
      date: (v) => v.toISOString(),
      boolean: (v) => (v ? 'true' : 'false'),
    },
  });
  secureWrite(path.join(dir, `${table.name}.csv`), csv);
}

/**
 * Write every table to its own CSV file inside
 *   <BACKUP_ROOT>/soldi-backup-<timestamp>/
 * plus a manifest.json describing the set. Old backups beyond BACKUP_KEEP are
 * pruned. Returns the absolute path of the backup directory.
 */
async function createBackup({ root = BACKUP_ROOT, keep = KEEP, label = 'auto' } = {}) {
  fs.mkdirSync(root, { recursive: true });

  // Letture prima, in un solo snapshot; i file si scrivono dopo.
  const snapshot = await withSnapshot(async (client) => {
    const out = [];
    for (const table of TABLES) {
      const { rows } = await client.query(
        `SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY ${table.columns[0]}`
      );
      out.push({ table, rows });
    }
    return out;
  });

  const dirName = `soldi-backup-${timestamp()}`;
  const dir = path.join(root, dirName);
  secureMkdir(dir);

  const manifest = {
    app: 'soldi',
    format: 1,
    label,
    createdAt: new Date().toISOString(),
    tables: {},
  };

  for (const { table, rows } of snapshot) {
    writeTableCsv(dir, table, rows);
    manifest.tables[table.name] = { rows: rows.length, file: `${table.name}.csv` };
  }

  secureWrite(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  pruneOldDirs(root, 'soldi-backup-', keep);

  return dir;
}

/**
 * Backup dei soli dati di un utente (tutte le tabelle in USER_SCOPED_TABLES,
 * filtrate per user_id), in
 *   <BACKUP_ROOT>/soldi-user-backup-<userId>-<timestamp>/
 * Non tocca né conta ai fini di BACKUP_KEEP i backup globali o quelli degli
 * altri utenti — la pulizia (`keep`) è per singolo utente.
 */
async function createUserBackup({ userId, email, root = BACKUP_ROOT, keep = KEEP, label = 'manual' }) {
  fs.mkdirSync(root, { recursive: true });

  const snapshot = await withSnapshot(async (client) => {
    const out = [];
    for (const table of USER_SCOPED_TABLES) {
      const { rows } = await client.query(
        `SELECT ${table.columns.join(', ')} FROM ${table.name} WHERE user_id = $1 ORDER BY ${table.columns[0]}`,
        [userId]
      );
      out.push({ table, rows });
    }
    return out;
  });

  const dirName = `${userBackupPrefix(userId)}${usernameSlug(email)}-${timestamp()}`;
  const dir = path.join(root, dirName);
  secureMkdir(dir);

  const manifest = {
    app: 'soldi',
    format: 1,
    kind: 'user',
    userId,
    email,
    label,
    createdAt: new Date().toISOString(),
    tables: {},
  };

  for (const { table, rows } of snapshot) {
    writeTableCsv(dir, table, rows);
    manifest.tables[table.name] = { rows: rows.length, file: `${table.name}.csv` };
  }

  secureWrite(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  pruneOldDirs(root, userBackupPrefix(userId), keep);

  return dir;
}

function userBackupPrefix(userId) {
  return `soldi-user-backup-${userId}-`;
}

/** Nomi delle cartelle di backup personale di un utente, dalla più vecchia alla più recente. */
function listUserBackups(userId, root = BACKUP_ROOT) {
  if (!fs.existsSync(root)) return [];
  const prefix = userBackupPrefix(userId);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort(byTimestamp);
}

function pruneOldDirs(root, prefix, keep) {
  if (!keep || keep < 1) return;
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort(byTimestamp);
  const excess = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of excess) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    console.log(`[backup] pruned old backup ${name}`);
  }
}

module.exports = {
  createBackup,
  createUserBackup,
  listUserBackups,
  userBackupPrefix,
  USER_SCOPED_TABLES,
  BACKUP_ROOT,
  byTimestamp,
  withSnapshot,
};

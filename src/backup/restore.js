'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool, withTransaction } = require('../db/pool');
const TABLES = require('./tables');
const { BACKUP_ROOT } = require('./backup-core');
const { readTableCsv } = require('./csv-table');
const { confirm } = require('./confirm');

function resolveBackupDir(arg) {
  if (arg && arg !== '--latest') {
    const dir = path.resolve(arg);
    if (!fs.existsSync(dir)) throw new Error(`Backup directory not found: ${dir}`);
    return dir;
  }
  // --latest (or no arg): newest soldi-backup-* under BACKUP_ROOT
  const candidates = fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('soldi-backup-'))
    .map((e) => e.name)
    .sort();
  if (candidates.length === 0) throw new Error(`No backups found under ${BACKUP_ROOT}`);
  return path.join(BACKUP_ROOT, candidates[candidates.length - 1]);
}

async function main() {
  const dir = resolveBackupDir(process.argv[2]);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;

  // Un backup personale contiene solo i dati di un utente: ripristinarlo qui
  // svuoterebbe tutti gli altri.
  if (manifest && manifest.kind === 'user') {
    throw new Error(
      `${dir} è un backup personale (utente ${manifest.email || manifest.userId}): ` +
        'per ripristinarlo usa `npm run user:restore -- <email> <cartella>`.'
    );
  }

  // I CSV si leggono PRIMA della conferma, così si può validare e mostrare cosa
  // verrà davvero scritto (anche per backup senza manifest).
  const parsed = TABLES.map((table) => {
    const { columns, rows } = readTableCsv(dir, table);
    return { table, columns, rows };
  });

  // Il ripristino globale parte da un TRUNCATE di tutto: senza utenti nel
  // backup (cartella sbagliata, CSV mancanti) lascerebbe il database vuoto.
  const usersRows = parsed.find((p) => p.table.name === 'users').rows;
  if (usersRows.length === 0) {
    throw new Error('users.csv assente o vuoto: rifiuto di svuotare il database.');
  }

  console.log(`\n[restore] source: ${dir}`);
  if (manifest) console.log(`[restore] created: ${manifest.createdAt} (label: ${manifest.label})`);
  for (const { table, rows } of parsed) {
    const expected = manifest?.tables?.[table.name]?.rows;
    const flag = expected != null && expected !== rows.length ? `  (manifest: ${expected} — DIVERSO)` : '';
    console.log(`[restore]   ${table.name}: ${rows.length} rows${flag}`);
  }
  console.log('\n[restore] This REPLACES all current data in the database.');

  const ok = await confirm('Type "yes" to continue: ');
  if (!ok) {
    console.log('[restore] aborted');
    await pool.end();
    return;
  }

  await withTransaction(async (client) => {
    await client.query(
      `TRUNCATE ${TABLES.map((t) => t.name).join(', ')} RESTART IDENTITY CASCADE`
    );

    for (const { table, columns, rows } of parsed) {
      if (rows.length === 0) continue;
      const colList = columns.join(', ');
      // Only tables with a GENERATED ALWAYS AS IDENTITY "id" need the override
      // and the sequence reset; config tables keyed by user_id do not.
      const hasIdentityId = table.columns.includes('id');
      const overriding = hasIdentityId ? 'OVERRIDING SYSTEM VALUE ' : '';
      // insert in chunks to keep parameter counts sane
      const CHUNK = Math.max(1, Math.floor(60000 / columns.length));
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const values = [];
        const tuples = slice.map((row) => {
          const placeholders = row.map((val) => {
            values.push(val);
            return `$${values.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        await client.query(
          `INSERT INTO ${table.name} (${colList}) ${overriding}VALUES ${tuples.join(', ')}`,
          values
        );
      }

      if (hasIdentityId) {
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, 'id'),
             GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table.name}), 1),
             (SELECT COUNT(*) FROM ${table.name}) > 0
           )`,
          [table.name]
        );
      }
      console.log(`[restore]   ${table.name}: ${rows.length} rows restored`);
    }

    // Prima del commit: se un CSV è troncato o mancante le righe inserite non
    // corrispondono al manifest e la transazione torna indietro (dati intatti).
    if (manifest && manifest.tables) {
      for (const { table } of parsed) {
        const expected = manifest.tables[table.name]?.rows;
        if (expected == null) continue;
        const {
          rows: [r],
        } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table.name}`);
        if (r.n !== expected) {
          throw new Error(`${table.name}: attese ${expected} righe, trovate ${r.n}`);
        }
      }
    }
  });

  console.log('\n[restore] done — all data replaced from backup.');
  await pool.end();
}

main().catch((err) => {
  console.error('[restore] failed:', err.message);
  process.exit(1);
});

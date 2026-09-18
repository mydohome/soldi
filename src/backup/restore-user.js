'use strict';

const fs = require('fs');
const path = require('path');
const { withTransaction } = require('../db/pool');
const { readTableCsv } = require('./csv-table');
const { BACKUP_ROOT, USER_SCOPED_TABLES, userBackupPrefix } = require('./backup-core');

// Ordine di cancellazione: figli prima dei genitori. Non è strettamente
// necessario (le FK sono ON DELETE SET NULL, non CASCADE), ma evita di
// lasciare per un istante movimenti che puntano a categorie/conti già
// cancellati nella stessa transazione.
const DELETE_ORDER = [
  'transactions',
  'planned_expenses',
  'recurring_rules',
  'accounts',
  'categories',
  'savings_settings',
  'telegram_settings',
];

/** Risolve "--latest"/assente o un nome di cartella nel percorso completo del backup di un utente. */
function resolveUserBackupDir(userId, arg, root = BACKUP_ROOT) {
  if (arg && arg !== '--latest') {
    const dir = path.isAbsolute(arg) ? arg : path.join(root, path.basename(arg));
    if (!fs.existsSync(dir)) throw new Error(`Cartella di backup non trovata: ${dir}`);
    return dir;
  }
  const prefix = userBackupPrefix(userId);
  const candidates = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
        .map((e) => e.name)
        .sort()
    : [];
  if (candidates.length === 0) {
    throw new Error(`Nessun backup personale trovato per questo utente sotto ${root}`);
  }
  return path.join(root, candidates[candidates.length - 1]);
}

function readManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
}

/** old id (stringa, dal CSV) → nuovo id assegnato dal DB. undefined/null → null (riferimento perso). */
function remap(map, oldValue) {
  if (oldValue === null || oldValue === undefined || oldValue === '') return null;
  const next = map.get(String(oldValue));
  return next === undefined ? null : next;
}

/**
 * Inserisce le righe di una tabella per un utente, forzando user_id e
 * rimappando le colonne FK indicate in fkMaps (vecchio id → nuovo id, dagli
 * inserimenti precedenti nella stessa tabella genitore). Le tabelle senza
 * colonna "id" (savings_settings, telegram_settings) sono chiavate su
 * user_id: nessun remap necessario, si inserisce e basta.
 * Ritorna una Map(vecchio id → nuovo id) per le tabelle che hanno "id".
 */
async function insertUserRows(client, tableName, { columns, rows }, { userId, fkMaps = {} }) {
  const idIndex = columns.indexOf('id');
  const userIdIndex = columns.indexOf('user_id');
  const newIds = new Map();

  for (const row of rows) {
    const values = [...row];
    if (userIdIndex !== -1) values[userIdIndex] = userId;
    for (const [col, map] of Object.entries(fkMaps)) {
      const idx = columns.indexOf(col);
      if (idx !== -1) values[idx] = remap(map, values[idx]);
    }

    const insertCols = columns.filter((c) => c !== 'id');
    const insertValues = values.filter((_, i) => columns[i] !== 'id');
    const placeholders = insertValues.map((_, i) => `$${i + 1}`);

    if (idIndex !== -1) {
      const oldId = row[idIndex];
      const { rows: [inserted] } = await client.query(
        `INSERT INTO ${tableName} (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
        insertValues
      );
      newIds.set(String(oldId), inserted.id);
    } else {
      await client.query(
        `INSERT INTO ${tableName} (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`,
        insertValues
      );
    }
  }

  return newIds;
}

/**
 * Ripristina il backup personale di UN utente: cancella le sue righe attuali
 * in tutte le tabelle e reinserisce quelle del backup, con ID rigenerati
 * (mai riusati quelli vecchi: sono globali e condivisi con altri utenti) e
 * le FK interne (categoria/conto/regola ricorrente) rimappate di conseguenza.
 * Non tocca in alcun modo i dati degli altri utenti.
 */
async function restoreUserBackup({ userId, dir }) {
  const parsed = {};
  for (const table of USER_SCOPED_TABLES) {
    parsed[table.name] = readTableCsv(dir, table);
  }

  const restored = await withTransaction(async (client) => {
    for (const name of DELETE_ORDER) {
      await client.query(`DELETE FROM ${name} WHERE user_id = $1`, [userId]);
    }

    const categoryIds = await insertUserRows(client, 'categories', parsed.categories, { userId });
    const accountIds = await insertUserRows(client, 'accounts', parsed.accounts, { userId });
    const recurringIds = await insertUserRows(client, 'recurring_rules', parsed.recurring_rules, {
      userId,
      fkMaps: { category_id: categoryIds, account_id: accountIds },
    });
    await insertUserRows(client, 'planned_expenses', parsed.planned_expenses, {
      userId,
      fkMaps: { category_id: categoryIds },
    });
    await insertUserRows(client, 'transactions', parsed.transactions, {
      userId,
      fkMaps: { category_id: categoryIds, account_id: accountIds, recurring_rule_id: recurringIds },
    });
    await insertUserRows(client, 'savings_settings', parsed.savings_settings, { userId });
    await insertUserRows(client, 'telegram_settings', parsed.telegram_settings, { userId });

    const summary = {};
    for (const table of USER_SCOPED_TABLES) summary[table.name] = parsed[table.name].rows.length;
    return summary;
  });

  return restored;
}

module.exports = { resolveUserBackupDir, readManifest, restoreUserBackup };

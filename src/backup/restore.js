'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parse } = require('csv-parse/sync');

const { pool, withTransaction } = require('../db/pool');
const TABLES = require('./tables');
const { BACKUP_ROOT } = require('./backup-core');

// Columns where an empty CSV field is a real empty string, not NULL.
const KEEP_EMPTY = new Set(['note', 'display_name']);

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

// Reads <table>.csv and returns { columns, rows }. Only the columns actually
// present in the CSV header are used, so a backup taken by an older version
// (missing a table or some columns) still restores — the DB defaults fill the
// gaps. A missing file is treated as an empty table with a warning.
function readTableCsv(dir, table) {
  const file = path.join(dir, `${table.name}.csv`);
  if (!fs.existsSync(file)) {
    console.warn(`[restore]   ${table.name}.csv not in backup — skipping (older backup format?)`);
    return { columns: [], rows: [] };
  }
  const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true });
  const present = records.length
    ? table.columns.filter((col) => col in records[0])
    : table.columns;
  const rows = records.map((rec) =>
    present.map((col) => {
      const raw = rec[col];
      if (raw === undefined || raw === '') return raw === '' && KEEP_EMPTY.has(col) ? '' : null;
      return raw;
    })
  );
  return { columns: present, rows };
}

async function confirm(question) {
  if (process.argv.includes('--yes') || process.env.RESTORE_ASSUME_YES === 'true') return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main() {
  const dir = resolveBackupDir(process.argv[2]);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;

  console.log(`\n[restore] source: ${dir}`);
  if (manifest) {
    console.log(`[restore] created: ${manifest.createdAt} (label: ${manifest.label})`);
    for (const [name, info] of Object.entries(manifest.tables)) {
      console.log(`[restore]   ${name}: ${info.rows} rows`);
    }
  }
  console.log('\n[restore] This REPLACES all current data in the database.');

  const ok = await confirm('Type "yes" to continue: ');
  if (!ok) {
    console.log('[restore] aborted');
    await pool.end();
    return;
  }

  const parsed = TABLES.map((table) => {
    const { columns, rows } = readTableCsv(dir, table);
    return { table, columns, rows };
  });

  await withTransaction(async (client) => {
    await client.query(
      `TRUNCATE ${TABLES.map((t) => t.name).join(', ')} RESTART IDENTITY CASCADE`
    );

    for (const { table, columns, rows } of parsed) {
      if (rows.length === 0) continue;
      const colList = columns.join(', ');
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
          `INSERT INTO ${table.name} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
          values
        );
      }

      await client.query(
        `SELECT setval(
           pg_get_serial_sequence($1, 'id'),
           GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table.name}), 1),
           (SELECT COUNT(*) FROM ${table.name}) > 0
         )`,
        [table.name]
      );
      console.log(`[restore]   ${table.name}: ${rows.length} rows restored`);
    }
  });

  console.log('\n[restore] done — all data replaced from backup.');
  await pool.end();
}

main().catch((err) => {
  console.error('[restore] failed:', err.message);
  process.exit(1);
});

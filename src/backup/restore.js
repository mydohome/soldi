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

function readTableCsv(dir, table) {
  const file = path.join(dir, `${table.name}.csv`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${table.name}.csv in backup`);
  const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true });
  return records.map((rec) =>
    table.columns.map((col) => {
      const raw = rec[col];
      if (raw === undefined) return null;
      if (raw === '' && !KEEP_EMPTY.has(col)) return null;
      return raw;
    })
  );
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

  const parsed = TABLES.map((table) => ({ table, rows: readTableCsv(dir, table) }));

  await withTransaction(async (client) => {
    await client.query(
      `TRUNCATE ${TABLES.map((t) => t.name).join(', ')} RESTART IDENTITY CASCADE`
    );

    for (const { table, rows } of parsed) {
      if (rows.length === 0) continue;
      const colList = table.columns.join(', ');
      // insert in chunks to keep parameter counts sane
      const CHUNK = Math.max(1, Math.floor(60000 / table.columns.length));
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

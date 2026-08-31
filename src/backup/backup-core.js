'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');

const { pool } = require('../db/pool');
const TABLES = require('./tables');

const BACKUP_ROOT = process.env.BACKUP_DIR || '/app/backups';
const KEEP = Number(process.env.BACKUP_KEEP || 8);

function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * Write every table to its own CSV file inside
 *   <BACKUP_ROOT>/soldi-backup-<timestamp>/
 * plus a manifest.json describing the set. Old backups beyond BACKUP_KEEP are
 * pruned. Returns the absolute path of the backup directory.
 */
async function createBackup({ root = BACKUP_ROOT, keep = KEEP, label = 'auto' } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dirName = `soldi-backup-${timestamp()}`;
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir);

  const manifest = {
    app: 'soldi',
    format: 1,
    label,
    createdAt: new Date().toISOString(),
    tables: {},
  };

  for (const table of TABLES) {
    const { rows } = await pool.query(
      `SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY id`
    );
    const csv = stringify(rows, { header: true, columns: table.columns, cast: { date: (v) => v.toISOString() } });
    const file = path.join(dir, `${table.name}.csv`);
    fs.writeFileSync(file, csv, 'utf8');
    manifest.tables[table.name] = { rows: rows.length, file: `${table.name}.csv` };
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  pruneOldBackups(root, keep);

  return dir;
}

function pruneOldBackups(root, keep) {
  if (!keep || keep < 1) return;
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('soldi-backup-'))
    .map((e) => e.name)
    .sort();
  const excess = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of excess) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    console.log(`[backup] pruned old backup ${name}`);
  }
}

module.exports = { createBackup, BACKUP_ROOT };

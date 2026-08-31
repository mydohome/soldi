'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

/**
 * Apply the schema. The schema file is fully idempotent (CREATE TABLE IF NOT
 * EXISTS / CREATE INDEX IF NOT EXISTS), so this runs safely on every boot and
 * doubles as a lightweight migration step for fresh databases.
 */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema applied');
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[db] migration failed', err);
      process.exit(1);
    });
}

module.exports = { migrate };

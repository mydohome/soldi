'use strict';

const { Pool, types } = require('pg');

// Return DATE columns (OID 1082) as plain 'YYYY-MM-DD' strings instead of JS
// Date objects, so a server in a non-UTC timezone never shifts a stored day.
types.setTypeParser(1082, (value) => value);

/**
 * A single shared connection pool. Configuration comes from the standard
 * PG* environment variables or a single DATABASE_URL, so the same code works
 * in docker-compose, in CI and on a managed Postgres.
 */
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 10) }
    : {
        host: process.env.PGHOST || 'db',
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'soldi',
        password: process.env.PGPASSWORD || 'soldi',
        database: process.env.PGDATABASE || 'soldi',
        max: Number(process.env.PG_POOL_MAX || 10),
      }
);

pool.on('error', (err) => {
  console.error('[db] unexpected pool error', err);
});

/** Run a query against the pool. */
function query(text, params) {
  return pool.query(text, params);
}

/** Run a function inside a transaction, committing on success. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };

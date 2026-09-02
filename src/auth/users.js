'use strict';

const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db/pool');
const defaultCategories = require('../data/default-categories');
const defaultAccounts = require('../data/default-accounts');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) {
    const err = new Error('Email non valida');
    err.code = 'bad_email';
    throw err;
  }
  return e;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    const err = new Error('La password deve avere tra 8 e 200 caratteri');
    err.code = 'bad_password';
    throw err;
  }
}

/**
 * Create a user and seed the default categories + accounts. Used by the
 * registration route and by the `npm run user:create` CLI.
 */
async function createUser({ email, password, displayName }) {
  const mail = normalizeEmail(email);
  checkPassword(password);
  const passwordHash = await bcrypt.hash(password, 12);

  return withTransaction(async (client) => {
    const existing = await client.query('SELECT 1 FROM users WHERE email = $1', [mail]);
    if (existing.rowCount > 0) {
      const err = new Error('Esiste già un account con questa email');
      err.code = 'email_taken';
      throw err;
    }

    const inserted = await client.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name`,
      [mail, passwordHash, (displayName && String(displayName).trim()) || mail.split('@')[0]]
    );
    const row = inserted.rows[0];

    for (const c of defaultCategories) {
      await client.query(
        `INSERT INTO categories (user_id, name, color, kind) VALUES ($1, $2, $3, $4)`,
        [row.id, c.name, c.color, c.kind]
      );
    }
    for (const a of defaultAccounts) {
      await client.query(
        `INSERT INTO accounts (user_id, name, kind, color) VALUES ($1, $2, $3, $4)`,
        [row.id, a.name, a.kind, a.color]
      );
    }
    return row;
  });
}

/** Set (reset) a user's password. Returns the updated row or null if unknown. */
async function setPassword(email, password) {
  const mail = normalizeEmail(email);
  checkPassword(password);
  const passwordHash = await bcrypt.hash(password, 12);
  const updated = await query(
    'UPDATE users SET password_hash = $2 WHERE email = $1 RETURNING id, email, display_name',
    [mail, passwordHash]
  );
  return updated.rows[0] || null;
}

module.exports = { createUser, setPassword, normalizeEmail, checkPassword };

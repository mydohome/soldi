'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const { query, withTransaction } = require('../db/pool');
const { COOKIE_NAME, signSession, cookieOptions } = require('../auth/tokens');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');
const defaultCategories = require('../data/default-categories');
const defaultAccounts = require('../data/default-accounts');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'La password deve avere almeno 8 caratteri').max(200),
  displayName: z.string().trim().max(80).optional(),
});

function setSession(res, user) {
  res.cookie(COOKIE_NAME, signSession(user), cookieOptions());
}

router.post(
  '/register',
  authLimiter,
  handler(async (req, res) => {
    const { email, password, displayName } = credentials.parse(req.body);

    const existing = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      throw httpError(409, 'email_taken', 'Esiste già un account con questa email');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name`,
        [email, passwordHash, displayName || email.split('@')[0]]
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

    setSession(res, user);
    res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  })
);

router.post(
  '/login',
  authLimiter,
  handler(async (req, res) => {
    const { email, password } = credentials.pick({ email: true, password: true }).parse(req.body);

    const found = await query(
      'SELECT id, email, password_hash, display_name FROM users WHERE email = $1',
      [email]
    );
    const user = found.rows[0];
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!ok) {
      throw httpError(401, 'invalid_credentials', 'Email o password non corretti');
    }

    setSession(res, user);
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  })
);

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  handler(async (req, res) => {
    const found = await query('SELECT id, email, display_name FROM users WHERE id = $1', [req.user.id]);
    if (found.rowCount === 0) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      throw httpError(401, 'not_authenticated', 'Sessione non valida');
    }
    const u = found.rows[0];
    res.json({ user: { id: u.id, email: u.email, displayName: u.display_name } });
  })
);

module.exports = router;

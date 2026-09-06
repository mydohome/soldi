'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const { query } = require('../db/pool');
const { COOKIE_NAME, signSession, cookieOptions, clearOptions } = require('../auth/tokens');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');
const { createUser } = require('../auth/users');

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

// Login must not leak the password policy — accept any non-empty string and let
// the credential check fail with a generic 401.
const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

function setSession(res, user) {
  res.cookie(COOKIE_NAME, signSession(user), cookieOptions());
}

/**
 * Registration is open when ALLOW_REGISTRATION isn't "false", OR when there are
 * no users yet (so a fresh install can always create its first account).
 */
async function registrationOpen() {
  if (process.env.ALLOW_REGISTRATION !== 'false') return true;
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n === 0;
}

router.get(
  '/config',
  handler(async (req, res) => {
    res.json({ registrationEnabled: await registrationOpen() });
  })
);

router.post(
  '/register',
  authLimiter,
  handler(async (req, res) => {
    if (!(await registrationOpen())) {
      throw httpError(403, 'registration_closed', 'La registrazione di nuovi utenti è disabilitata');
    }
    const { email, password, displayName } = credentials.parse(req.body);

    let user;
    try {
      user = await createUser({ email, password, displayName });
    } catch (err) {
      if (err.code === 'email_taken') throw httpError(409, 'email_taken', err.message);
      throw err;
    }

    setSession(res, user);
    res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  })
);

router.post(
  '/login',
  authLimiter,
  handler(async (req, res) => {
    const { email, password } = loginInput.parse(req.body);

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
  res.clearCookie(COOKIE_NAME, clearOptions());
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  handler(async (req, res) => {
    const found = await query('SELECT id, email, display_name FROM users WHERE id = $1', [req.user.id]);
    if (found.rowCount === 0) {
      res.clearCookie(COOKIE_NAME, clearOptions());
      throw httpError(401, 'not_authenticated', 'Sessione non valida');
    }
    const u = found.rows[0];
    res.json({ user: { id: u.id, email: u.email, displayName: u.display_name } });
  })
);

module.exports = router;

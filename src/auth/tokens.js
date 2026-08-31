'use strict';

const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'soldi_session';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set (>=16 chars) in production');
    }
    console.warn('[auth] JWT_SECRET missing/weak — using an insecure dev default');
    return 'dev-only-insecure-secret-change-me';
  }
  return s;
}

function signSession(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, secret(), {
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

function verifySession(token) {
  return jwt.verify(token, secret());
}

/** Options for res.cookie so the session cookie is safe by default. */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  };
}

module.exports = { COOKIE_NAME, TOKEN_TTL_SECONDS, signSession, verifySession, cookieOptions };

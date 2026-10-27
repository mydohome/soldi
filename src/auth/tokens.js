'use strict';

const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'soldi_session';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Valori di esempio pubblici (.env.example, documentazione): chi li conosce potrebbe firmare sessioni valide.
const PLACEHOLDER_SECRET = /^(change[-_ ]?me|secret|password|insecure|dev-only)/i;
const ALGORITHM = 'HS256';

/** Da chiamare all'avvio: in produzione rifiuta un JWT_SECRET mancante, corto o di esempio. */
function assertSecret() {
  if (process.env.NODE_ENV !== 'production') return;
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error('JWT_SECRET deve essere impostato (almeno 16 caratteri) in produzione');
  if (PLACEHOLDER_SECRET.test(s)) {
    throw new Error(
      'JWT_SECRET ha ancora il valore di esempio (pubblico): chiunque potrebbe falsificare le sessioni. ' +
        'Generane uno nuovo con `openssl rand -hex 32`, mettilo nel .env e riavvia.'
    );
  }
}

function secret() {
  assertSecret();
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
    algorithm: ALGORITHM,
  });
}

function verifySession(token) {
  return jwt.verify(token, secret(), { algorithms: [ALGORITHM] });
}

const cookieSecure = () =>
  process.env.COOKIE_SECURE === 'true' || process.env.HTTPS_ENABLED === 'true';

/** Options for res.cookie so the session cookie is safe by default. */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  };
}

/**
 * Options for res.clearCookie. Browsers only drop a cookie when path, secure and
 * sameSite match those it was set with, so keep these in sync with cookieOptions.
 */
function clearOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: cookieSecure(), path: '/' };
}

module.exports = {
  assertSecret,
  COOKIE_NAME,
  TOKEN_TTL_SECONDS,
  signSession,
  verifySession,
  cookieOptions,
  clearOptions,
};

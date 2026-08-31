'use strict';

const { COOKIE_NAME, verifySession } = require('./tokens');

/**
 * Require a valid session cookie. On success attaches `req.user = { id, email }`.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  try {
    const payload = verifySession(token);
    req.user = { id: Number(payload.sub), email: payload.email };
    return next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.status(401).json({ error: 'session_expired' });
  }
}

module.exports = { requireAuth };

'use strict';

const { ZodError } = require('zod');

/**
 * Wrap an async route handler so thrown ZodErrors become 400s and everything
 * else becomes a clean 500 (logged, not leaked).
 */
function handler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: 'validation_failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      if (err && err.status && err.expose) {
        return res.status(err.status).json({ error: err.code || 'error', message: err.message });
      }
      console.error('[http] unhandled error', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}

/** Small helper to raise a client-visible error from inside a handler. */
function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

module.exports = { handler, httpError };

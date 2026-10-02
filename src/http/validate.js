'use strict';

const { z, ZodError } = require('zod');

/** Data YYYY-MM-DD che esiste davvero (non 2026-02-31, né il mese 13). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (YYYY-MM-DD)')
  .refine((s) => {
    // Date non valide: toISOString() lancerebbe un RangeError (500), quindi si controlla prima.
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '0001-01-01';
  }, 'Data non esistente');

// CHECK di schema.sql che impongono il mese alle voci annuali.
const YEARLY_MONTH_CONSTRAINTS = new Set(['recurring_yearly_month_check', 'planned_yearly_month_check']);

/**
 * Wrap an async route handler so thrown ZodErrors become 400s and everything
 * else becomes a clean 500 (logged, not leaked).
 */
function handler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (err && err.code === '23514' && YEARLY_MONTH_CONSTRAINTS.has(err.constraint)) {
        err = httpError(400, 'yearly_needs_month', 'Per una voce annuale serve il mese');
      }
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

module.exports = { handler, httpError, isoDate };

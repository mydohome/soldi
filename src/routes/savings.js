'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler } = require('../http/validate');
const { computeSavingsPlan } = require('../summary/savings');

const router = express.Router();
router.use(requireAuth);

const DEFAULTS = { emergencyMonths: 3, emergencySplit: 70 };

async function loadSettings(userId) {
  const r = await query(
    'SELECT emergency_months, emergency_split FROM savings_settings WHERE user_id = $1',
    [userId]
  );
  if (!r.rowCount) return { ...DEFAULTS };
  return {
    emergencyMonths: r.rows[0].emergency_months,
    emergencySplit: r.rows[0].emergency_split,
  };
}

const monthlyEquivalentCents = (row) =>
  row.cadence === 'yearly' ? Number(row.amount_cents) / 12 : Number(row.amount_cents);

router.get(
  '/',
  handler(async (req, res) => {
    const settings = await loadSettings(req.user.id);

    // The 12 full calendar months before the current one, zero-filled.
    const monthly = await query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE) - interval '12 month',
           date_trunc('month', CURRENT_DATE) - interval '1 month',
           interval '1 month'
         )::date AS m
       )
       SELECT to_char(months.m, 'YYYY-MM') AS month,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income'), 0)  AS income_cents,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense'), 0) AS expense_cents
       FROM months
       LEFT JOIN transactions t
         ON t.user_id = $1 AND date_trunc('month', t.occurred_on) = months.m
       GROUP BY months.m
       ORDER BY months.m`,
      [req.user.id]
    );

    const rows = monthly.rows.map((r) => ({
      month: r.month,
      income: Number(r.income_cents) / 100,
      expense: Number(r.expense_cents) / 100,
    }));
    // Leading empty months = the user hadn't started tracking yet.
    while (rows.length && rows[0].income === 0 && rows[0].expense === 0) rows.shift();

    const recurring = await query(
      `SELECT amount_cents, cadence FROM recurring_rules
       WHERE user_id = $1 AND active = true AND type = 'expense'`,
      [req.user.id]
    );
    const committedMonthly =
      recurring.rows.reduce((acc, r) => acc + monthlyEquivalentCents(r), 0) / 100;

    res.json(computeSavingsPlan({ months: rows, committedMonthly, settings }));
  })
);

const patchInput = z
  .object({
    emergencyMonths: z.coerce.number().int().min(1).max(24).optional(),
    emergencySplit: z.coerce.number().int().min(0).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nessun campo da aggiornare' });

router.patch(
  '/',
  handler(async (req, res) => {
    const patch = patchInput.parse(req.body);
    const next = { ...(await loadSettings(req.user.id)), ...patch };
    await query(
      `INSERT INTO savings_settings (user_id, emergency_months, emergency_split, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET
         emergency_months = EXCLUDED.emergency_months,
         emergency_split  = EXCLUDED.emergency_split,
         updated_at       = now()`,
      [req.user.id, next.emergencyMonths, next.emergencySplit]
    );
    res.json({ ok: true, settings: next });
  })
);

module.exports = router;

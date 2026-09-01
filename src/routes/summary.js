'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scopeParam = z.enum(['personal', 'home']).optional();
const euros = (cents) => Number(cents || 0) / 100;

// Returns [" AND t.scope = $N", value] or ["", undefined] — callers append the
// clause to their WHERE and push the value onto their params array.
function scopeFilter(scope, nextParamIndex) {
  if (!scope) return { clause: '', value: undefined };
  return { clause: ` AND t.scope = $${nextParamIndex}`, value: scope };
}

const net = (income, expense) => Number((income - expense).toFixed(2));

/**
 * Totals for a [from, to] inclusive window, always broken down by scope
 * (personal / home) so the dashboard can show both plus the total.
 */
async function totals(userId, from, to, scope) {
  const sf = scopeFilter(scope, 4);
  const params = [userId, from, to];
  if (sf.value) params.push(sf.value);
  const r = await query(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income'), 0)  AS income,
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense'), 0) AS expense,
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income'  AND scope = 'personal'), 0) AS inc_p,
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense' AND scope = 'personal'), 0) AS exp_p,
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income'  AND scope = 'home'), 0) AS inc_h,
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense' AND scope = 'home'), 0) AS exp_h
     FROM transactions t
     WHERE user_id = $1 AND occurred_on BETWEEN $2 AND $3${sf.clause}`,
    params
  );
  const row = r.rows[0];
  const income = euros(row.income);
  const expense = euros(row.expense);
  const mk = (i, e) => ({ income: euros(i), expense: euros(e), net: net(euros(i), euros(e)) });
  return {
    from,
    to,
    income,
    expense,
    net: net(income, expense),
    personal: mk(row.inc_p, row.exp_p),
    home: mk(row.inc_h, row.exp_h),
  };
}

async function byCategory(userId, from, to, type, scope) {
  const sf = scopeFilter(scope, 5);
  const params = [userId, from, to, type];
  if (sf.value) params.push(sf.value);
  const r = await query(
    `SELECT c.id AS category_id,
            COALESCE(c.name, 'Senza categoria') AS name,
            COALESCE(c.color, '#9aa4b2') AS color,
            SUM(t.amount_cents) AS total
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1 AND t.type = $4 AND t.occurred_on BETWEEN $2 AND $3${sf.clause}
     GROUP BY c.id, c.name, c.color
     ORDER BY total DESC`,
    params
  );
  return r.rows.map((row) => ({
    categoryId: row.category_id,
    name: row.name,
    color: row.color,
    total: euros(row.total),
  }));
}

async function byAccount(userId, from, to, type, scope) {
  const sf = scopeFilter(scope, 5);
  const params = [userId, from, to, type];
  if (sf.value) params.push(sf.value);
  const r = await query(
    `SELECT a.id AS account_id,
            COALESCE(a.name, 'Nessun conto') AS name,
            COALESCE(a.color, '#9aa4b2') AS color,
            SUM(t.amount_cents) AS total
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = $1 AND t.type = $4 AND t.occurred_on BETWEEN $2 AND $3${sf.clause}
     GROUP BY a.id, a.name, a.color
     ORDER BY total DESC`,
    params
  );
  return r.rows.map((row) => ({
    accountId: row.account_id,
    name: row.name,
    color: row.color,
    total: euros(row.total),
  }));
}

/** Income/expense totals split by scope (personal vs home) for a window. */
async function scopeSplit(userId, from, to) {
  const r = await query(
    `SELECT t.scope,
            COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income'), 0)  AS income,
            COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense'), 0) AS expense
     FROM transactions t
     WHERE user_id = $1 AND occurred_on BETWEEN $2 AND $3
     GROUP BY t.scope`,
    [userId, from, to]
  );
  const out = {
    personal: { income: 0, expense: 0, net: 0 },
    home: { income: 0, expense: 0, net: 0 },
  };
  for (const row of r.rows) {
    const bucket = out[row.scope] || (out[row.scope] = { income: 0, expense: 0, net: 0 });
    bucket.income = euros(row.income);
    bucket.expense = euros(row.expense);
    bucket.net = Number((bucket.income - bucket.expense).toFixed(2));
  }
  return out;
}

router.get(
  '/overview',
  handler(async (req, res) => {
    const anchor = (req.query.anchor && isoDate.parse(req.query.anchor)) || null;
    const scope = scopeParam.parse(req.query.scope);
    const a = anchor || new Date().toISOString().slice(0, 10);

    // Resolve day / week (Mon-Sun) / month windows for the anchor date in SQL.
    const w = await query(
      `SELECT
         $1::date                                             AS day_from,
         $1::date                                             AS day_to,
         date_trunc('week', $1::date)::date                   AS week_from,
         (date_trunc('week', $1::date) + interval '6 day')::date AS week_to,
         date_trunc('month', $1::date)::date                  AS month_from,
         (date_trunc('month', $1::date) + interval '1 month - 1 day')::date AS month_to`,
      [a]
    );
    const win = w.rows[0];
    const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x);

    const [day, week, month] = await Promise.all([
      totals(req.user.id, d(win.day_from), d(win.day_to), scope),
      totals(req.user.id, d(win.week_from), d(win.week_to), scope),
      totals(req.user.id, d(win.month_from), d(win.month_to), scope),
    ]);

    const [expenseByCategory, incomeByCategory, expenseByAccount, split] = await Promise.all([
      byCategory(req.user.id, month.from, month.to, 'expense', scope),
      byCategory(req.user.id, month.from, month.to, 'income', scope),
      byAccount(req.user.id, month.from, month.to, 'expense', scope),
      scopeSplit(req.user.id, month.from, month.to),
    ]);

    const trendParams = [req.user.id, a];
    let scopeClause = '';
    if (scope) {
      trendParams.push(scope);
      scopeClause = 'AND t.scope = $3';
    }

    // Daily trend: 30 days ending on the anchor, zero-filled.
    const daily = await query(
      `WITH days AS (
         SELECT generate_series($2::date - interval '29 day', $2::date, interval '1 day')::date AS d
       )
       SELECT days.d AS date,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income'), 0)  AS income,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense'), 0) AS expense
       FROM days
       LEFT JOIN transactions t
         ON t.user_id = $1 AND t.occurred_on = days.d ${scopeClause}
       GROUP BY days.d
       ORDER BY days.d`,
      trendParams
    );

    // Monthly trend: 6 months ending on the anchor month, zero-filled.
    const monthly = await query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', $2::date) - interval '5 month',
           date_trunc('month', $2::date),
           interval '1 month'
         )::date AS m
       )
       SELECT to_char(months.m, 'YYYY-MM') AS month,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income'), 0)  AS income,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense'), 0) AS expense
       FROM months
       LEFT JOIN transactions t
         ON t.user_id = $1 AND date_trunc('month', t.occurred_on) = months.m ${scopeClause}
       GROUP BY months.m
       ORDER BY months.m`,
      trendParams
    );

    res.json({
      anchor: a,
      scope: scope || null,
      day,
      week,
      month,
      scopeSplit: split,
      expenseByCategory,
      incomeByCategory,
      expenseByAccount,
      dailyTrend: daily.rows.map((r) => ({
        date: d(r.date),
        income: euros(r.income),
        expense: euros(r.expense),
      })),
      monthlyTrend: monthly.rows.map((r) => ({
        month: r.month,
        income: euros(r.income),
        expense: euros(r.expense),
      })),
    });
  })
);

const rangeQuery = z.object({
  from: isoDate,
  to: isoDate,
  group: z.enum(['day', 'week', 'month']).default('day'),
  scope: scopeParam,
});

router.get(
  '/range',
  handler(async (req, res) => {
    const q = rangeQuery.parse(req.query);
    const step = { day: '1 day', week: '1 week', month: '1 month' }[q.group];
    const params = [q.from, q.to, q.group, step, req.user.id];
    let scopeClause = '';
    if (q.scope) {
      params.push(q.scope);
      scopeClause = `AND t.scope = $${params.length}`;
    }
    const rows = await query(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc($3, $1::date),
           date_trunc($3, $2::date),
           $4::interval
         ) AS bucket
       )
       SELECT to_char(buckets.bucket, 'YYYY-MM-DD') AS bucket,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'income'), 0)  AS income,
              COALESCE(SUM(t.amount_cents) FILTER (WHERE t.type = 'expense'), 0) AS expense
       FROM buckets
       LEFT JOIN transactions t
         ON t.user_id = $5
        AND date_trunc($3, t.occurred_on) = buckets.bucket ${scopeClause}
       GROUP BY buckets.bucket
       ORDER BY buckets.bucket`,
      params
    );
    res.json({
      group: q.group,
      scope: q.scope || null,
      series: rows.rows.map((r) => ({
        bucket: r.bucket,
        income: euros(r.income),
        expense: euros(r.expense),
        net: Number((euros(r.income) - euros(r.expense)).toFixed(2)),
      })),
    });
  })
);

module.exports = router;

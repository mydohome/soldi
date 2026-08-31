'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const euros = (cents) => Number(cents || 0) / 100;

/** Totals (income / expense / net) for a [from, to] inclusive date window. */
async function totals(userId, from, to) {
  const r = await query(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'income'), 0)  AS income,
       COALESCE(SUM(amount_cents) FILTER (WHERE type = 'expense'), 0) AS expense
     FROM transactions
     WHERE user_id = $1 AND occurred_on BETWEEN $2 AND $3`,
    [userId, from, to]
  );
  const income = euros(r.rows[0].income);
  const expense = euros(r.rows[0].expense);
  return { from, to, income, expense, net: Number((income - expense).toFixed(2)) };
}

async function byCategory(userId, from, to, type) {
  const r = await query(
    `SELECT c.id AS category_id,
            COALESCE(c.name, 'Senza categoria') AS name,
            COALESCE(c.color, '#9aa4b2') AS color,
            SUM(t.amount_cents) AS total
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1 AND t.type = $4 AND t.occurred_on BETWEEN $2 AND $3
     GROUP BY c.id, c.name, c.color
     ORDER BY total DESC`,
    [userId, from, to, type]
  );
  return r.rows.map((row) => ({
    categoryId: row.category_id,
    name: row.name,
    color: row.color,
    total: euros(row.total),
  }));
}

router.get(
  '/overview',
  handler(async (req, res) => {
    const anchor = (req.query.anchor && isoDate.parse(req.query.anchor)) || null;
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
      totals(req.user.id, d(win.day_from), d(win.day_to)),
      totals(req.user.id, d(win.week_from), d(win.week_to)),
      totals(req.user.id, d(win.month_from), d(win.month_to)),
    ]);

    const [expenseByCategory, incomeByCategory] = await Promise.all([
      byCategory(req.user.id, month.from, month.to, 'expense'),
      byCategory(req.user.id, month.from, month.to, 'income'),
    ]);

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
         ON t.user_id = $1 AND t.occurred_on = days.d
       GROUP BY days.d
       ORDER BY days.d`,
      [req.user.id, a]
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
         ON t.user_id = $1 AND date_trunc('month', t.occurred_on) = months.m
       GROUP BY months.m
       ORDER BY months.m`,
      [req.user.id, a]
    );

    res.json({
      anchor: a,
      day,
      week,
      month,
      expenseByCategory,
      incomeByCategory,
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
});

router.get(
  '/range',
  handler(async (req, res) => {
    const q = rangeQuery.parse(req.query);
    const step = { day: '1 day', week: '1 week', month: '1 month' }[q.group];
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
        AND date_trunc($3, t.occurred_on) = buckets.bucket
       GROUP BY buckets.bucket
       ORDER BY buckets.bucket`,
      [q.from, q.to, q.group, step, req.user.id]
    );
    res.json({
      group: q.group,
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

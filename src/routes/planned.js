'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

const euros = (c) => Number(c || 0) / 100;
const toCents = (e) => Math.round(e * 100);

const plannedInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    categoryId: z.coerce.number().int().positive().nullable().optional(),
    scope: z.enum(['personal', 'home']).default('personal'),
    amount: z.coerce.number().positive('L’importo deve essere maggiore di zero').max(1_000_000_000),
    cadence: z.enum(['monthly', 'yearly']).default('monthly'),
    month: z.coerce.number().int().min(1).max(12).nullable().optional(),
    active: z.boolean().default(true),
    note: z.string().trim().max(280).default(''),
  })
  .refine((v) => v.cadence !== 'yearly' || (v.month != null), {
    message: 'Per una voce annuale serve il mese',
    path: ['month'],
  });

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
    scope: row.scope,
    amount: euros(row.amount_cents),
    cadence: row.cadence,
    month: row.month,
    active: row.active,
    note: row.note,
  };
}

const SELECT_PLANNED = `
  SELECT p.*, c.name AS category_name, c.color AS category_color
  FROM planned_expenses p
  LEFT JOIN categories c ON c.id = p.category_id`;

async function assertCategoryOwned(userId, categoryId) {
  if (categoryId == null) return;
  const f = await query('SELECT 1 FROM categories WHERE id = $1 AND user_id = $2', [categoryId, userId]);
  if (f.rowCount === 0) throw httpError(400, 'bad_category', 'Categoria non valida');
}

router.get(
  '/',
  handler(async (req, res) => {
    const rows = await query(
      `${SELECT_PLANNED} WHERE p.user_id = $1 ORDER BY p.active DESC, p.name`,
      [req.user.id]
    );
    res.json({ planned: rows.rows.map(shape) });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = plannedInput.parse(req.body);
    await assertCategoryOwned(req.user.id, input.categoryId ?? null);
    const inserted = await query(
      `INSERT INTO planned_expenses
         (user_id, name, category_id, scope, amount_cents, cadence, month, active, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.user.id,
        input.name,
        input.categoryId ?? null,
        input.scope,
        toCents(input.amount),
        input.cadence,
        input.cadence === 'yearly' ? input.month : null,
        input.active,
        input.note,
      ]
    );
    const row = await query(`${SELECT_PLANNED} WHERE p.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ planned: shape(row.rows[0]) });
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = plannedInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    if ('categoryId' in patch) await assertCategoryOwned(req.user.id, patch.categoryId ?? null);

    const updated = await query(
      `UPDATE planned_expenses
       SET name = COALESCE($3, name),
           category_id = CASE WHEN $4::boolean THEN $5 ELSE category_id END,
           scope = COALESCE($6, scope),
           amount_cents = COALESCE($7, amount_cents),
           cadence = COALESCE($8, cadence),
           month = CASE
                     WHEN COALESCE($8, cadence) = 'monthly' THEN NULL
                     WHEN $9::int IS NOT NULL THEN $9
                     ELSE month
                   END,
           active = COALESCE($10, active),
           note = COALESCE($11, note)
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [
        id,
        req.user.id,
        patch.name ?? null,
        'categoryId' in patch,
        patch.categoryId ?? null,
        patch.scope ?? null,
        patch.amount != null ? toCents(patch.amount) : null,
        patch.cadence ?? null,
        patch.month ?? null,
        patch.active ?? null,
        patch.note ?? null,
      ]
    );
    if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Voce non trovata');
    const row = await query(`${SELECT_PLANNED} WHERE p.id = $1`, [id]);
    res.json({ planned: shape(row.rows[0]) });
  })
);

router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const del = await query('DELETE FROM planned_expenses WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
    if (del.rowCount === 0) throw httpError(404, 'not_found', 'Voce non trovata');
    res.json({ ok: true });
  })
);

/* --------------------------------------------------- annual forecast summary */

const summaryQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  includeRecurring: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
  scope: z.enum(['personal', 'home']).optional(),
});

router.get(
  '/summary',
  handler(async (req, res) => {
    const q = summaryQuery.parse(req.query);
    const now = new Date();
    const year = q.year || now.getUTCFullYear();
    const curYear = now.getUTCFullYear();
    const curMonth = now.getUTCMonth() + 1;
    const scopeSql = q.scope ? ` AND scope = '${q.scope}'` : ''; // scope is a validated enum

    // Planned items (active), optionally + active recurring expense rules.
    const planned = await query(
      `SELECT p.cadence, p.month, p.scope, p.amount_cents, p.category_id,
              c.name AS category_name, c.color AS category_color
       FROM planned_expenses p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.user_id = $1 AND p.active = true${scopeSql}`,
      [req.user.id]
    );

    let recurring = { rows: [] };
    if (q.includeRecurring) {
      recurring = await query(
        `SELECT r.amount_cents, r.scope, r.category_id,
                c.name AS category_name, c.color AS category_color
         FROM recurring_rules r
         LEFT JOIN categories c ON c.id = r.category_id
         WHERE r.user_id = $1 AND r.active = true AND r.type = 'expense'${scopeSql}`,
        [req.user.id]
      );
    }

    // Actual expenses for the year, per month.
    const actual = await query(
      `SELECT EXTRACT(MONTH FROM occurred_on)::int AS m,
              SUM(amount_cents) AS total
       FROM transactions t
       WHERE user_id = $1 AND type = 'expense'
         AND occurred_on >= make_date($2, 1, 1)
         AND occurred_on <  make_date($2 + 1, 1, 1)${scopeSql}
       GROUP BY 1`,
      [req.user.id, year]
    );
    const actualByCat = await query(
      `SELECT t.category_id,
              COALESCE(c.name, 'Senza categoria') AS name,
              COALESCE(c.color, '#9aa4b2') AS color,
              SUM(t.amount_cents) AS total
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1 AND t.type = 'expense'
         AND t.occurred_on >= make_date($2, 1, 1)
         AND t.occurred_on <  make_date($2 + 1, 1, 1)${scopeSql}
       GROUP BY 1, 2, 3`,
      [req.user.id, year]
    );

    const plannedByMonth = Array(12).fill(0);
    const actualByMonth = Array(12).fill(0);
    const byScope = { personal: { planned: 0, actual: 0 }, home: { planned: 0, actual: 0 } };
    const cats = new Map(); // categoryId|null -> {name,color,planned,actual}

    const bump = (map, id, name, color) => {
      const key = id == null ? 'none' : String(id);
      if (!map.has(key)) map.set(key, { categoryId: id, name, color, planned: 0, actual: 0 });
      return map.get(key);
    };

    for (const row of actual.rows) actualByMonth[row.m - 1] = euros(row.total);
    for (const row of planned.rows) {
      const amt = euros(row.amount_cents);
      const months = row.cadence === 'monthly' ? [...Array(12).keys()].map((i) => i + 1) : [row.month];
      for (const m of months) plannedByMonth[m - 1] += amt;
      byScope[row.scope].planned += row.cadence === 'monthly' ? amt * 12 : amt;
      const c = bump(cats, row.category_id, row.category_name || 'Senza categoria', row.category_color || '#9aa4b2');
      c.planned += row.cadence === 'monthly' ? amt * 12 : amt;
    }
    for (const row of recurring.rows) {
      const amt = euros(row.amount_cents);
      for (let m = 0; m < 12; m++) plannedByMonth[m] += amt;
      byScope[row.scope].planned += amt * 12;
      const c = bump(cats, row.category_id, row.category_name || 'Senza categoria', row.category_color || '#9aa4b2');
      c.planned += amt * 12;
    }
    for (const row of actualByCat.rows) {
      const c = bump(cats, row.category_id, row.name, row.color);
      c.actual += euros(row.total);
    }
    // scope actuals
    const actualScope = await query(
      `SELECT scope, SUM(amount_cents) AS total
       FROM transactions
       WHERE user_id = $1 AND type = 'expense'
         AND occurred_on >= make_date($2, 1, 1)
         AND occurred_on <  make_date($2 + 1, 1, 1)${scopeSql}
       GROUP BY scope`,
      [req.user.id, year]
    );
    for (const row of actualScope.rows) byScope[row.scope].actual = euros(row.total);

    const round = (n) => Number(n.toFixed(2));
    const totalPlanned = round(plannedByMonth.reduce((a, b) => a + b, 0));
    const totalActual = round(actualByMonth.reduce((a, b) => a + b, 0));

    // Projection: past/current months use actuals, future months use plan.
    let projected = 0;
    for (let m = 1; m <= 12; m++) {
      if (year < curYear) projected += actualByMonth[m - 1];
      else if (year > curYear) projected += plannedByMonth[m - 1];
      else projected += m <= curMonth ? actualByMonth[m - 1] : plannedByMonth[m - 1];
    }

    res.json({
      year,
      includeRecurring: q.includeRecurring,
      scope: q.scope || null,
      totalPlanned,
      totalActual,
      projectedYearEnd: round(projected),
      months: plannedByMonth.map((p, i) => ({
        month: i + 1,
        planned: round(p),
        actual: round(actualByMonth[i]),
      })),
      byCategory: [...cats.values()]
        .map((c) => ({ ...c, planned: round(c.planned), actual: round(c.actual) }))
        .sort((a, b) => b.planned - a.planned || b.actual - a.actual),
      byScope: {
        personal: { planned: round(byScope.personal.planned), actual: round(byScope.personal.actual) },
        home: { planned: round(byScope.home.planned), actual: round(byScope.home.actual) },
      },
    });
  })
);

module.exports = router;

'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');
const { generateDue } = require('../recurring/generate');

const router = express.Router();
router.use(requireAuth);

const ruleInput = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['expense', 'income']).default('expense'),
  amount: z.coerce.number().positive('L’importo deve essere maggiore di zero').max(1_000_000_000),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  accountId: z.coerce.number().int().positive().nullable().optional(),
  scope: z.enum(['personal', 'home']).default('personal'),
  dayOfMonth: z.coerce.number().int().min(1).max(28).default(1),
  note: z.string().trim().max(280).default(''),
  active: z.boolean().default(true),
});

const toCents = (e) => Math.round(e * 100);
const toEuros = (c) => Number(c) / 100;
const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x);

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    amount: toEuros(row.amount_cents),
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
    accountId: row.account_id,
    accountName: row.account_name,
    scope: row.scope,
    dayOfMonth: row.day_of_month,
    note: row.note,
    active: row.active,
    startMonth: d(row.start_month),
    lastRunMonth: row.last_run_month ? d(row.last_run_month) : null,
  };
}

async function assertOwned(table, label, userId, id) {
  if (id == null) return;
  const found = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (found.rowCount === 0) throw httpError(400, `bad_${label}`, `${label === 'category' ? 'Categoria' : 'Conto'} non valido`);
}

const SELECT_RULE = `
  SELECT r.*, c.name AS category_name, c.color AS category_color, a.name AS account_name
  FROM recurring_rules r
  LEFT JOIN categories c ON c.id = r.category_id
  LEFT JOIN accounts   a ON a.id = r.account_id`;

router.get(
  '/',
  handler(async (req, res) => {
    const rows = await query(`${SELECT_RULE} WHERE r.user_id = $1 ORDER BY r.active DESC, r.name`, [
      req.user.id,
    ]);
    res.json({ rules: rows.rows.map(shape) });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = ruleInput.parse(req.body);
    await assertOwned('categories', 'category', req.user.id, input.categoryId ?? null);
    await assertOwned('accounts', 'account', req.user.id, input.accountId ?? null);

    const inserted = await query(
      `INSERT INTO recurring_rules
         (user_id, name, type, amount_cents, category_id, account_id, scope, day_of_month, note, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        req.user.id,
        input.name,
        input.type,
        toCents(input.amount),
        input.categoryId ?? null,
        input.accountId ?? null,
        input.scope,
        input.dayOfMonth,
        input.note,
        input.active,
      ]
    );
    // Generate any occurrence already due this month for the new rule.
    const gen = await generateDue({ userId: req.user.id });
    const row = await query(`${SELECT_RULE} WHERE r.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ rule: shape(row.rows[0]), generated: gen.created });
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = ruleInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    if ('categoryId' in patch) await assertOwned('categories', 'category', req.user.id, patch.categoryId ?? null);
    if ('accountId' in patch) await assertOwned('accounts', 'account', req.user.id, patch.accountId ?? null);

    const updated = await query(
      `UPDATE recurring_rules
       SET name = COALESCE($3, name),
           type = COALESCE($4, type),
           amount_cents = COALESCE($5, amount_cents),
           category_id = CASE WHEN $6::boolean THEN $7 ELSE category_id END,
           account_id = CASE WHEN $8::boolean THEN $9 ELSE account_id END,
           scope = COALESCE($10, scope),
           day_of_month = COALESCE($11, day_of_month),
           note = COALESCE($12, note),
           -- On reactivation, resume from the current month: don't backfill the
           -- months the rule spent switched off.
           last_run_month = CASE
             WHEN $13::boolean IS TRUE AND active IS FALSE
             THEN GREATEST(last_run_month, (date_trunc('month', CURRENT_DATE) - interval '1 month')::date)
             ELSE last_run_month
           END,
           active = COALESCE($13, active)
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [
        id,
        req.user.id,
        patch.name ?? null,
        patch.type ?? null,
        patch.amount != null ? toCents(patch.amount) : null,
        'categoryId' in patch,
        patch.categoryId ?? null,
        'accountId' in patch,
        patch.accountId ?? null,
        patch.scope ?? null,
        patch.dayOfMonth ?? null,
        patch.note ?? null,
        patch.active ?? null,
      ]
    );
    if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Spesa fissa non trovata');

    const gen = await generateDue({ userId: req.user.id });
    const row = await query(`${SELECT_RULE} WHERE r.id = $1`, [id]);
    res.json({ rule: shape(row.rows[0]), generated: gen.created });
  })
);

router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const keep = req.query.keepMovimenti === 'true';
    if (!keep) {
      await query(
        'DELETE FROM transactions WHERE recurring_rule_id = $1 AND user_id = $2',
        [id, req.user.id]
      );
    }
    const deleted = await query('DELETE FROM recurring_rules WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
    if (deleted.rowCount === 0) throw httpError(404, 'not_found', 'Spesa fissa non trovata');
    res.json({ ok: true });
  })
);

router.post(
  '/run',
  handler(async (req, res) => {
    const gen = await generateDue({ userId: req.user.id });
    res.json(gen);
  })
);

module.exports = router;

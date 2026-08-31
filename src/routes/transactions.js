'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (YYYY-MM-DD)');

const txInput = z.object({
  type: z.enum(['expense', 'income']),
  amount: z.coerce.number().positive('L’importo deve essere maggiore di zero').max(1_000_000_000),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  accountId: z.coerce.number().int().positive().nullable().optional(),
  scope: z.enum(['personal', 'home']).default('personal'),
  note: z.string().trim().max(280).default(''),
  occurredOn: isoDate.optional(),
});

const toCents = (euros) => Math.round(euros * 100);
const toEuros = (cents) => Number(cents) / 100;

const SELECT_TX = `
  SELECT t.*,
         c.name AS category_name, c.color AS category_color,
         a.name AS account_name,  a.color AS account_color
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN accounts   a ON a.id = t.account_id`;

function shape(row) {
  return {
    id: row.id,
    type: row.type,
    amount: toEuros(row.amount_cents),
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
    accountId: row.account_id,
    accountName: row.account_name,
    accountColor: row.account_color,
    scope: row.scope,
    note: row.note,
    occurredOn:
      row.occurred_on instanceof Date ? row.occurred_on.toISOString().slice(0, 10) : row.occurred_on,
  };
}

async function assertOwned(table, label, userId, id) {
  if (id == null) return;
  const found = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (found.rowCount === 0) throw httpError(400, `bad_${label}`, `${label === 'category' ? 'Categoria' : 'Conto'} non valido`);
}

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(['expense', 'income']).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
  scope: z.enum(['personal', 'home']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/',
  handler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const where = ['t.user_id = $1'];
    const params = [req.user.id];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.from) add('t.occurred_on >= ?', q.from);
    if (q.to) add('t.occurred_on <= ?', q.to);
    if (q.type) add('t.type = ?', q.type);
    if (q.categoryId) add('t.category_id = ?', q.categoryId);
    if (q.accountId) add('t.account_id = ?', q.accountId);
    if (q.scope) add('t.scope = ?', q.scope);

    params.push(q.limit, q.offset);
    const rows = await query(
      `${SELECT_TX}
       WHERE ${where.join(' AND ')}
       ORDER BY t.occurred_on DESC, t.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ transactions: rows.rows.map(shape) });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = txInput.parse(req.body);
    await assertOwned('categories', 'category', req.user.id, input.categoryId ?? null);
    await assertOwned('accounts', 'account', req.user.id, input.accountId ?? null);

    const inserted = await query(
      `INSERT INTO transactions
         (user_id, type, amount_cents, category_id, account_id, scope, note, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_DATE))
       RETURNING id`,
      [
        req.user.id,
        input.type,
        toCents(input.amount),
        input.categoryId ?? null,
        input.accountId ?? null,
        input.scope,
        input.note,
        input.occurredOn ?? null,
      ]
    );
    const row = await query(`${SELECT_TX} WHERE t.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ transaction: shape(row.rows[0]) });
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = txInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    if ('categoryId' in patch) await assertOwned('categories', 'category', req.user.id, patch.categoryId ?? null);
    if ('accountId' in patch) await assertOwned('accounts', 'account', req.user.id, patch.accountId ?? null);

    const updated = await query(
      `UPDATE transactions
       SET type = COALESCE($3, type),
           amount_cents = COALESCE($4, amount_cents),
           category_id = CASE WHEN $5::boolean THEN $6 ELSE category_id END,
           account_id = CASE WHEN $7::boolean THEN $8 ELSE account_id END,
           scope = COALESCE($9, scope),
           note = COALESCE($10, note),
           occurred_on = COALESCE($11, occurred_on)
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [
        id,
        req.user.id,
        patch.type ?? null,
        patch.amount != null ? toCents(patch.amount) : null,
        'categoryId' in patch,
        patch.categoryId ?? null,
        'accountId' in patch,
        patch.accountId ?? null,
        patch.scope ?? null,
        patch.note ?? null,
        patch.occurredOn ?? null,
      ]
    );
    if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Movimento non trovato');

    const row = await query(`${SELECT_TX} WHERE t.id = $1`, [id]);
    res.json({ transaction: shape(row.rows[0]) });
  })
);

router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const deleted = await query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
    if (deleted.rowCount === 0) throw httpError(404, 'not_found', 'Movimento non trovato');
    res.json({ ok: true });
  })
);

module.exports = router;

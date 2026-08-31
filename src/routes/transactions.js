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
  note: z.string().trim().max(280).default(''),
  occurredOn: isoDate.optional(),
});

const toCents = (euros) => Math.round(euros * 100);
const toEuros = (cents) => Number(cents) / 100;

function shape(row) {
  return {
    id: row.id,
    type: row.type,
    amount: toEuros(row.amount_cents),
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
    note: row.note,
    occurredOn: row.occurred_on instanceof Date ? row.occurred_on.toISOString().slice(0, 10) : row.occurred_on,
  };
}

async function assertCategoryOwned(userId, categoryId) {
  if (categoryId == null) return;
  const found = await query('SELECT 1 FROM categories WHERE id = $1 AND user_id = $2', [
    categoryId,
    userId,
  ]);
  if (found.rowCount === 0) throw httpError(400, 'bad_category', 'Categoria non valida');
}

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(['expense', 'income']).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
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

    params.push(q.limit, q.offset);
    const rows = await query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
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
    await assertCategoryOwned(req.user.id, input.categoryId ?? null);
    const inserted = await query(
      `INSERT INTO transactions (user_id, type, amount_cents, category_id, note, occurred_on)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE))
       RETURNING *`,
      [req.user.id, input.type, toCents(input.amount), input.categoryId ?? null, input.note, input.occurredOn ?? null]
    );
    const withCat = await query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.id = $1`,
      [inserted.rows[0].id]
    );
    res.status(201).json({ transaction: shape(withCat.rows[0]) });
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = txInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    if ('categoryId' in patch) await assertCategoryOwned(req.user.id, patch.categoryId ?? null);

    const updated = await query(
      `UPDATE transactions
       SET type = COALESCE($3, type),
           amount_cents = COALESCE($4, amount_cents),
           category_id = CASE WHEN $5::boolean THEN $6 ELSE category_id END,
           note = COALESCE($7, note),
           occurred_on = COALESCE($8, occurred_on)
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [
        id,
        req.user.id,
        patch.type ?? null,
        patch.amount != null ? toCents(patch.amount) : null,
        'categoryId' in patch,
        patch.categoryId ?? null,
        patch.note ?? null,
        patch.occurredOn ?? null,
      ]
    );
    if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Movimento non trovato');

    const withCat = await query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.id = $1`,
      [id]
    );
    res.json({ transaction: shape(withCat.rows[0]) });
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

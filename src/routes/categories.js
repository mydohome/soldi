'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colore non valido (usa #rrggbb)');

const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  color: hexColor.default('#6c8cff'),
  kind: z.enum(['expense', 'income']).default('expense'),
});

router.get(
  '/',
  handler(async (req, res) => {
    const rows = await query(
      `SELECT c.id, c.name, c.color, c.kind,
              COUNT(t.id)::int AS tx_count
       FROM categories c
       LEFT JOIN transactions t ON t.category_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.kind, c.name`,
      [req.user.id]
    );
    res.json({ categories: rows.rows });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = categoryInput.parse(req.body);
    try {
      const inserted = await query(
        `INSERT INTO categories (user_id, name, color, kind)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, color, kind`,
        [req.user.id, input.name, input.color, input.kind]
      );
      res.status(201).json({ category: inserted.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        throw httpError(409, 'category_exists', 'Categoria già presente');
      }
      throw err;
    }
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = categoryInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');

    const updated = await query(
      `UPDATE categories
       SET name = COALESCE($3, name),
           color = COALESCE($4, color),
           kind = COALESCE($5, kind)
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, color, kind`,
      [id, req.user.id, patch.name ?? null, patch.color ?? null, patch.kind ?? null]
    );
    if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Categoria non trovata');
    res.json({ category: updated.rows[0] });
  })
);

router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    // Transactions keep their history; their category_id becomes NULL (ON DELETE SET NULL).
    const deleted = await query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
    if (deleted.rowCount === 0) throw httpError(404, 'not_found', 'Categoria non trovata');
    res.json({ ok: true });
  })
);

module.exports = router;

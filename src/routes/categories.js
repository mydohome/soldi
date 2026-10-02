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
  scope: z.enum(['personal', 'home']).default('personal'),
});

router.get(
  '/',
  handler(async (req, res) => {
    const rows = await query(
      `SELECT c.id, c.name, c.color, c.kind, c.scope,
              COUNT(t.id)::int AS tx_count
       FROM categories c
       LEFT JOIN transactions t ON t.category_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY c.kind, c.scope, c.name`,
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
        `INSERT INTO categories (user_id, name, color, kind, scope)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, color, kind, scope`,
        [req.user.id, input.name, input.color, input.kind, input.scope]
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

    // Cambiare tipo (spesa/entrata) a una categoria già usata la renderebbe
    // incompatibile con i suoi movimenti: si rifiuta. Nome, colore e ambito restano liberi.
    if (patch.kind) {
      const cur = await query('SELECT kind FROM categories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (cur.rowCount === 0) throw httpError(404, 'not_found', 'Categoria non trovata');
      if (cur.rows[0].kind !== patch.kind) {
        const used = await query(
          `SELECT
             (SELECT COUNT(*) FROM transactions WHERE category_id = $1 AND user_id = $2 AND type <> $3::text)
           + (SELECT COUNT(*) FROM recurring_rules WHERE category_id = $1 AND user_id = $2 AND type <> $3::text)
           + CASE WHEN $3::text <> 'expense'
                  THEN (SELECT COUNT(*) FROM planned_expenses WHERE category_id = $1 AND user_id = $2)
                  ELSE 0 END AS n`,
          [id, req.user.id, patch.kind]
        );
        if (Number(used.rows[0].n) > 0) {
          throw httpError(409, 'category_in_use', 'La categoria ha movimenti o spese fisse di tipo diverso');
        }
      }
    }

    try {
      const updated = await query(
        `UPDATE categories
         SET name = COALESCE($3, name),
             color = COALESCE($4, color),
             kind = COALESCE($5, kind),
             scope = COALESCE($6, scope)
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, color, kind, scope`,
        [id, req.user.id, patch.name ?? null, patch.color ?? null, patch.kind ?? null, patch.scope ?? null]
      );
      if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Categoria non trovata');
      res.json({ category: updated.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        throw httpError(409, 'category_exists', 'Categoria già presente con questo nome, tipo e ambito');
      }
      throw err;
    }
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

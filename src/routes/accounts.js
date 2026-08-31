'use strict';

const express = require('express');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colore non valido (usa #rrggbb)');

const accountInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['bank', 'cash', 'card', 'savings', 'other']).default('bank'),
  color: hexColor.default('#6c8cff'),
});

router.get(
  '/',
  handler(async (req, res) => {
    const rows = await query(
      `SELECT a.id, a.name, a.kind, a.color,
              COUNT(t.id)::int AS tx_count
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.user_id = $1
       GROUP BY a.id
       ORDER BY a.name`,
      [req.user.id]
    );
    res.json({ accounts: rows.rows });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = accountInput.parse(req.body);
    try {
      const inserted = await query(
        `INSERT INTO accounts (user_id, name, kind, color)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, kind, color`,
        [req.user.id, input.name, input.kind, input.color]
      );
      res.status(201).json({ account: inserted.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        throw httpError(409, 'account_exists', 'Conto già presente');
      }
      throw err;
    }
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = accountInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');

    const updated = await query(
      `UPDATE accounts
       SET name = COALESCE($3, name),
           kind = COALESCE($4, kind),
           color = COALESCE($5, color)
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, kind, color`,
      [id, req.user.id, patch.name ?? null, patch.kind ?? null, patch.color ?? null]
    );
    if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Conto non trovato');
    res.json({ account: updated.rows[0] });
  })
);

router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    // Movimenti collegati restano; il loro account_id diventa NULL (ON DELETE SET NULL).
    const deleted = await query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [
      id,
      req.user.id,
    ]);
    if (deleted.rowCount === 0) throw httpError(404, 'not_found', 'Conto non trovato');
    res.json({ ok: true });
  })
);

module.exports = router;

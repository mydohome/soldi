'use strict';

const express = require('express');
const { z } = require('zod');

const { query, withTransaction } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError, isoDate } = require('../http/validate');
const { assertCategory, categoryPairChanged } = require('../http/category-check');
const { buildSuggestions } = require('../transactions/suggest');
const { filterFields, buildTxFilter } = require('../transactions/filters');
const { rateImpact } = require('../recurring/rates');
const { generateDue } = require('../recurring/generate');

const router = express.Router();
router.use(requireAuth);

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
    recurringRuleId: row.recurring_rule_id,
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
  ...filterFields,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/',
  handler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const { where, params } = buildTxFilter(req.user.id, q);

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

const suggestQuery = z.object({
  note: z.string().max(280).optional().default(''),
  type: z.enum(['expense', 'income']).optional(),
  scope: z.enum(['personal', 'home']).optional(),
});

router.get(
  '/suggest',
  handler(async (req, res) => {
    const q = suggestQuery.parse(req.query);
    const where = ['user_id = $1'];
    const params = [req.user.id];
    if (q.type) {
      params.push(q.type);
      where.push(`type = $${params.length}`);
    }
    if (q.scope) {
      params.push(q.scope);
      where.push(`scope = $${params.length}`);
    }

    const [history, cats, accs] = await Promise.all([
      query(
        `SELECT note, category_id, account_id, occurred_on
         FROM transactions
         WHERE ${where.join(' AND ')}
         ORDER BY occurred_on DESC, id DESC
         LIMIT 600`,
        params
      ),
      query('SELECT id, name, color FROM categories WHERE user_id = $1', [req.user.id]),
      query('SELECT id, name, color FROM accounts WHERE user_id = $1', [req.user.id]),
    ]);

    const norm = (row) => ({
      ...row,
      occurred_on:
        row.occurred_on instanceof Date
          ? row.occurred_on.toISOString().slice(0, 10)
          : row.occurred_on,
    });

    res.json(
      buildSuggestions({
        rows: history.rows.map(norm),
        note: q.note,
        catById: new Map(cats.rows.map((c) => [String(c.id), c])),
        accById: new Map(accs.rows.map((a) => [String(a.id), a])),
      })
    );
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = txInput.parse(req.body);
    await assertCategory(req.user.id, input.categoryId ?? null, input.type);
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
    if ('type' in patch || 'categoryId' in patch) {
      // Si valida la coppia effettiva (tipo, categoria) solo se uno dei due cambia davvero:
      // così un dato storico incoerente non blocca la modifica degli altri campi.
      const cur = await query('SELECT type, category_id FROM transactions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (cur.rowCount === 0) throw httpError(404, 'not_found', 'Movimento non trovato');
      const next = {
        type: patch.type ?? cur.rows[0].type,
        categoryId: 'categoryId' in patch ? patch.categoryId ?? null : cur.rows[0].category_id,
      };
      if (categoryPairChanged(cur.rows[0], next)) await assertCategory(req.user.id, next.categoryId, next.type);
    }
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

// Eliminando il movimento di una rata di una spesa fissa a durata limitata, l'interfaccia chiede se
// aggiornare lo stato delle rate. Questa anteprima dice se la domanda ha senso e che effetto avrebbe.
router.get(
  '/:id/rate-impact',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const tx = await query('SELECT recurring_rule_id, occurred_on FROM transactions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (tx.rowCount === 0) throw httpError(404, 'not_found', 'Movimento non trovato');
    if (tx.rows[0].recurring_rule_id == null) return res.json({ applicable: false });
    const rule = await query('SELECT * FROM recurring_rules WHERE id = $1 AND user_id = $2', [tx.rows[0].recurring_rule_id, req.user.id]);
    const impact = rule.rowCount ? rateImpact(rule.rows[0], tx.rows[0].occurred_on) : null;
    if (!impact) return res.json({ applicable: false });
    res.json({
      applicable: true,
      ruleId: rule.rows[0].id,
      ruleName: rule.rows[0].name,
      cadence: rule.rows[0].cadence,
      number: impact.number,
      total: impact.total,
      doneBefore: impact.doneBefore,
      doneAfter: impact.doneAfter,
      endBefore: impact.endBefore,
      endAfter: impact.endAfter,
      willGenerateNow: impact.willGenerateNow,
    });
  })
);

// DELETE /api/transactions/:id            elimina soltanto il movimento (la rata resta contata come addebitata)
// DELETE /api/transactions/:id?updateRates=true   elimina e aggiorna le rate: il mese diventa una rata saltata
router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const updateRates = req.query.updateRates === 'true';
    const out = await withTransaction(async (client) => {
      const found = await client.query(
        'SELECT recurring_rule_id, occurred_on FROM transactions WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, req.user.id]
      );
      if (found.rowCount === 0) throw httpError(404, 'not_found', 'Movimento non trovato');
      const tx = found.rows[0];
      await client.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!updateRates || tx.recurring_rule_id == null) return { ratesUpdated: false };
      const rule = await client.query('SELECT * FROM recurring_rules WHERE id = $1 AND user_id = $2 FOR UPDATE', [tx.recurring_rule_id, req.user.id]);
      const impact = rule.rowCount ? rateImpact(rule.rows[0], tx.occurred_on) : null;
      if (!impact) return { ratesUpdated: false };
      // una regola già conclusa torna attiva: ha di nuovo una rata da addebitare in coda al piano
      const reactivate = !rule.rows[0].active && impact.completed;
      await client.query(
        'UPDATE recurring_rules SET skipped_months = $2, active = CASE WHEN $3::boolean THEN true ELSE active END WHERE id = $1',
        [rule.rows[0].id, impact.skippedAfter, reactivate]
      );
      return { ratesUpdated: true, reactivated: reactivate };
    });
    // la nuova ultima rata, se è già dovuta, si crea subito
    const generated = out.ratesUpdated ? (await generateDue({ userId: req.user.id })).created : 0;
    res.json({ ok: true, ...out, generated });
  })
);

module.exports = router;

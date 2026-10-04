'use strict';

const express = require('express');
const { z } = require('zod');

const { query, withTransaction } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');
const { assertCategory, categoryPairChanged } = require('../http/category-check');
const { generateDue } = require('../recurring/generate');
const {
  installmentProgress, monthKey, monthsBetween, addMonthsKey, firstSlotKey, scheduleEndMonth,
  skippedSet, skippedToString, dueSlots,
} = require('../recurring/schedule');

const router = express.Router();
router.use(requireAuth);

const ruleShape = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['expense', 'income']).default('expense'),
  amount: z.coerce.number().positive('L’importo deve essere maggiore di zero').max(1_000_000_000),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  accountId: z.coerce.number().int().positive().nullable().optional(),
  scope: z.enum(['personal', 'home']).default('personal'),
  cadence: z.enum(['monthly', 'yearly']).default('monthly'),
  month: z.coerce.number().int().min(1).max(12).nullable().optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).default(1),
  // Numero di rate/occorrenze; null = a tempo indeterminato.
  totalOccurrences: z.coerce.number().int().min(1).max(600).nullable().optional(),
  note: z.string().trim().max(280).default(''),
  active: z.boolean().default(true),
  // Mese di inizio (YYYY-MM, oppure YYYY-MM-DD: conta il mese). Se è nel passato i movimenti dei
  // mesi trascorsi vengono creati subito; se si cambia su una regola esistente i movimenti già
  // generati si spostano di conseguenza.
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, 'Data di inizio non valida (AAAA-MM)').optional(),
});
const normalizeStart = (s) => `${s.slice(0, 7)}-01`;

const yearlyNeedsMonth = (v) => v.cadence !== 'yearly' || v.month != null;
const yearlyMonthIssue = { message: 'Per una spesa fissa annuale serve il mese', path: ['month'] };

// z.object(...).refine(...) is a ZodEffects and has no .partial(); keep the raw
// shape around so the PATCH handler can build a partial schema from it.
const ruleInput = ruleShape.refine(yearlyNeedsMonth, yearlyMonthIssue);

const toCents = (e) => Math.round(e * 100);
const toEuros = (c) => Number(c) / 100;
const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x);

function shape(row) {
  // La regola con le date già normalizzate in stringhe YYYY-MM-DD (il pool le
  // restituisce già così; d() copre anche un eventuale Date).
  const rule = { ...row, start_month: d(row.start_month), last_run_month: row.last_run_month ? d(row.last_run_month) : null };
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
    cadence: row.cadence,
    month: row.month,
    dayOfMonth: row.day_of_month,
    totalOccurrences: row.total_occurrences,
    occurrencesDone: row.occurrences_done ?? null,
    note: row.note,
    active: row.active,
    startMonth: rule.start_month,
    lastRunMonth: rule.last_run_month,
    // mesi saltati dal piano (rate non addebitate su richiesta dell'utente), 'YYYY-MM'
    skippedMonths: [...skippedSet(row.skipped_months)].sort(),
    // Avanzamento a calendario (null per le regole a tempo indeterminato). Non
    // dipende da occurrencesDone, che conta i movimenti ed è quindi sensibile
    // alla cancellazione di un movimento generato.
    progress: installmentProgress(rule, row.paid_cents),
  };
}

async function assertOwned(table, label, userId, id) {
  if (id == null) return;
  const found = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (found.rowCount === 0) throw httpError(400, `bad_${label}`, `${label === 'category' ? 'Categoria' : 'Conto'} non valido`);
}

const SELECT_RULE = `
  SELECT r.*, c.name AS category_name, c.color AS category_color, a.name AS account_name,
         (SELECT COUNT(*)::int FROM transactions t WHERE t.recurring_rule_id = r.id) AS occurrences_done,
         (SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t WHERE t.recurring_rule_id = r.id) AS paid_cents
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
    await assertCategory(req.user.id, input.categoryId ?? null, input.type);
    await assertOwned('accounts', 'account', req.user.id, input.accountId ?? null);

    const inserted = await query(
      `INSERT INTO recurring_rules
         (user_id, name, type, amount_cents, category_id, account_id, scope, cadence, month, day_of_month, total_occurrences, note, active, start_month)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::date, date_trunc('month', CURRENT_DATE)::date))
       RETURNING id`,
      [
        req.user.id,
        input.name,
        input.type,
        toCents(input.amount),
        input.categoryId ?? null,
        input.accountId ?? null,
        input.scope,
        input.cadence,
        input.cadence === 'yearly' ? input.month : null,
        input.dayOfMonth,
        input.totalOccurrences ?? null,
        input.note,
        input.active,
        input.startMonth ? normalizeStart(input.startMonth) : null,
      ]
    );
    // Generate any occurrence already due for the new rule (con un inizio nel passato, anche gli arretrati).
    const gen = await generateDue({ userId: req.user.id });
    const row = await query(`${SELECT_RULE} WHERE r.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ rule: shape(row.rows[0]), generated: gen.created });
  })
);

// ---------------------------------------------------------------- cambio della data di inizio
// Cambiando l'inizio i movimenti già generati si spostano dello stesso numero di mesi del primo
// slot (di anni interi per le annuali); lo spostamento vale anche per il cursore dell'ultimo mese
// generato e per le rate saltate, così la data finale (se la regola ha un numero di rate) slitta
// di conseguenza. Se nello stesso salvataggio cambiano anche cadenza o mese, i movimenti esistenti
// non hanno più una corrispondenza con gli slot: non si spostano.
function startShiftPlan(cur, newStartKey, patch = {}) {
  const cadence = patch.cadence ?? cur.cadence;
  const month = cadence === 'yearly' ? patch.month ?? cur.month : null;
  const oldStart = monthKey(cur.start_month);
  const compatible = cadence === cur.cadence && (cadence !== 'yearly' || month === cur.month);
  const oldFirst = firstSlotKey(cur, oldStart);
  const newFirst = firstSlotKey({ ...cur, cadence, month }, newStartKey);
  const delta = compatible ? monthsBetween(oldFirst, newFirst) : 0;
  return { compatible, delta, oldFirst, newFirst };
}
const shiftKey = (key, delta) => addMonthsKey(monthKey(key), delta);
function shiftedRule(cur, newStartKey, delta) {
  return {
    ...cur,
    start_month: newStartKey,
    last_run_month: cur.last_run_month && delta ? shiftKey(cur.last_run_month, delta) : cur.last_run_month,
    skipped_months: skippedToString(new Set([...skippedSet(cur.skipped_months)].map((k) => shiftKey(`${k}-01`, delta).slice(0, 7)))),
  };
}

async function shiftStart(client, cur, newStartKey, patch) {
  const plan = startShiftPlan(cur, newStartKey, patch);
  if (!plan.compatible || plan.delta === 0) return { applied: false, movements: 0, months: 0 };
  const { delta } = plan;
  // Un movimento alla volta, dal più lontano nella direzione dello spostamento: l'indice univoco
  // (regola, mese) non deve mai vedere due movimenti nello stesso mese.
  const rows = await client.query(
    `SELECT id FROM transactions WHERE recurring_rule_id = $1 AND user_id = $2 ORDER BY occurred_on ${delta > 0 ? 'DESC' : 'ASC'}, id`,
    [cur.id, cur.user_id]
  );
  for (const r of rows.rows) {
    await client.query(`UPDATE transactions SET occurred_on = (occurred_on + make_interval(months => $2::int))::date WHERE id = $1`, [r.id, delta]);
  }
  const after = shiftedRule(cur, newStartKey, delta);
  await client.query('UPDATE recurring_rules SET last_run_month = $2, skipped_months = $3 WHERE id = $1', [cur.id, after.last_run_month, after.skipped_months]);
  return { applied: true, movements: rows.rowCount, months: delta };
}

// Anteprima (nessuna scrittura) di che cosa succede cambiando l'inizio: serve alla conferma nell'interfaccia.
router.get(
  '/:id/start-preview',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    // cadenza e mese facoltativi: se cambiano insieme all'inizio, i movimenti esistenti non si spostano
    const q = z
      .object({
        startMonth: ruleShape.shape.startMonth.unwrap(),
        cadence: z.enum(['monthly', 'yearly']).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
      })
      .parse(req.query);
    const { startMonth } = q;
    const found = await query('SELECT * FROM recurring_rules WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (found.rowCount === 0) throw httpError(404, 'not_found', 'Spesa fissa non trovata');
    const cur = found.rows[0];
    const newStart = normalizeStart(startMonth);
    const changed = newStart !== monthKey(cur.start_month);
    const plan = startShiftPlan(cur, newStart, { cadence: q.cadence, month: q.month });
    const after = shiftedRule(cur, newStart, plan.delta);

    const mov = await query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE (occurred_on + make_interval(months => $3::int))::date >= date_trunc('month', CURRENT_DATE + interval '1 month'))::int AS future
       FROM transactions WHERE recurring_rule_id = $1 AND user_id = $2`,
      [id, req.user.id, plan.delta]
    );
    // mesi che generateDue creerebbe subito dopo lo spostamento (arretrati)
    const now = new Date();
    const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const lastDue = now.getUTCDate() >= cur.day_of_month ? curMonth : addMonthsKey(curMonth, -1);
    const backfill = cur.active ? dueSlots(after, after.last_run_month, lastDue).length : 0;
    const endBefore = scheduleEndMonth(cur, monthKey(cur.start_month));
    const endAfter = scheduleEndMonth(after, newStart);
    res.json({
      changed,
      shifted: changed && plan.compatible && plan.delta !== 0,
      months: changed && plan.compatible ? plan.delta : 0,
      movements: mov.rows[0].n,
      futureMovements: changed && plan.compatible ? mov.rows[0].future : 0,
      firstBefore: plan.oldFirst.slice(0, 7),
      firstAfter: plan.newFirst.slice(0, 7),
      endBefore: endBefore ? endBefore.slice(0, 7) : null,
      endAfter: endAfter ? endAfter.slice(0, 7) : null,
      backfill,
    });
  })
);

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const patch = ruleShape.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    if ('type' in patch || 'categoryId' in patch) {
      // Come per i movimenti: si controlla solo se tipo o categoria cambiano davvero.
      const cur = await query('SELECT type, category_id FROM recurring_rules WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (cur.rowCount === 0) throw httpError(404, 'not_found', 'Spesa fissa non trovata');
      const next = {
        type: patch.type ?? cur.rows[0].type,
        categoryId: 'categoryId' in patch ? patch.categoryId ?? null : cur.rows[0].category_id,
      };
      if (categoryPairChanged(cur.rows[0], next)) await assertCategory(req.user.id, next.categoryId, next.type);
    }
    if ('accountId' in patch) await assertOwned('accounts', 'account', req.user.id, patch.accountId ?? null);

    const newStart = patch.startMonth ? normalizeStart(patch.startMonth) : null;
    let shifted = { applied: false, movements: 0, months: 0 };
    await withTransaction(async (client) => {
      const found = await client.query('SELECT * FROM recurring_rules WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
      if (found.rowCount === 0) throw httpError(404, 'not_found', 'Spesa fissa non trovata');
      const cur = found.rows[0];
      if (newStart && newStart !== monthKey(cur.start_month)) shifted = await shiftStart(client, cur, newStart, patch);
      const updated = await client.query(
        `UPDATE recurring_rules
         SET name = COALESCE($3, name),
             type = COALESCE($4, type),
             amount_cents = COALESCE($5, amount_cents),
             category_id = CASE WHEN $6::boolean THEN $7 ELSE category_id END,
             account_id = CASE WHEN $8::boolean THEN $9 ELSE account_id END,
             scope = COALESCE($10, scope),
             cadence = COALESCE($11, cadence),
             month = CASE
                       WHEN COALESCE($11, cadence) = 'monthly' THEN NULL
                       WHEN $12::int IS NOT NULL THEN $12
                       ELSE month
                     END,
             day_of_month = COALESCE($13, day_of_month),
             total_occurrences = CASE WHEN $16::boolean THEN $17 ELSE total_occurrences END,
             note = COALESCE($14, note),
             -- On reactivation, resume from the current month: don't backfill the
             -- months the rule spent switched off.
             last_run_month = CASE
               WHEN $15::boolean IS TRUE AND active IS FALSE
               THEN GREATEST(last_run_month, (date_trunc('month', CURRENT_DATE) - interval '1 month')::date)
               ELSE last_run_month
             END,
             active = COALESCE($15, active),
             start_month = COALESCE($18::date, start_month)
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
          patch.cadence ?? null,
          patch.month ?? null,
          patch.dayOfMonth ?? null,
          patch.note ?? null,
          patch.active ?? null,
          'totalOccurrences' in patch,
          patch.totalOccurrences ?? null,
          newStart,
        ]
      );
      if (updated.rowCount === 0) throw httpError(404, 'not_found', 'Spesa fissa non trovata');

    });

    const gen = await generateDue({ userId: req.user.id });
    const row = await query(`${SELECT_RULE} WHERE r.id = $1`, [id]);
    res.json({ rule: shape(row.rows[0]), generated: gen.created, shifted });
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

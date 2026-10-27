'use strict';

const express = require('express');
const { z } = require('zod');

const { query, withTransaction } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError, isoDate } = require('../http/validate');
const { assertCategory } = require('../http/category-check');
const { todayKey, generateInstallments, splitAmount, installmentStatus } = require('../payments/schedule');

const router = express.Router();
router.use(requireAuth);

const MAX_INSTALLMENTS = 120;

const toCents = (e) => Math.round(e * 100);
const euros = (c) => Number(c) / 100;
const idParam = (v) => z.coerce.number().int().positive().parse(v);

const amountField = z.coerce.number().positive('L’importo deve essere maggiore di zero').max(1_000_000_000);
const installmentInput = z.object({ dueOn: isoDate, amount: amountField });

const planShape = z.object({
  name: z.string().trim().min(1).max(80),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  accountId: z.coerce.number().int().positive().nullable().optional(),
  scope: z.enum(['personal', 'home']).default('personal'),
  note: z.string().trim().max(280).default(''),
});
const createInput = planShape.extend({
  installments: z.array(installmentInput).min(1, 'Serve almeno una rata').max(MAX_INSTALLMENTS, `Al massimo ${MAX_INSTALLMENTS} rate`),
});
const generateInput = z.object({
  count: z.coerce.number().int().min(1).max(MAX_INSTALLMENTS),
  firstDue: isoDate,
  everyMonths: z.coerce.number().int().min(1).max(12).default(1),
  mode: z.enum(['each', 'total']).default('each'),
  amount: amountField,
});
const equalizeInput = z.object({ mode: z.enum(['each', 'total']), amount: amountField });
const payInput = z.object({
  occurredOn: isoDate.optional(),
  amount: amountField.optional(),
  accountId: z.coerce.number().int().positive().nullable().optional(),
  note: z.string().trim().max(280).optional(),
});

async function assertAccount(userId, id) {
  if (id == null) return;
  const f = await query('SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2', [id, userId]);
  if (f.rowCount === 0) throw httpError(400, 'bad_account', 'Conto non valido');
}

// Le rate di un utente con numero d'ordine e totale del piano (funzioni finestra: vanno calcolate
// PRIMA di filtrare, quindi il filtro sta nella query esterna) e il movimento che le ha saldate.
const INSTALLMENTS_SQL = `
  SELECT * FROM (
    SELECT i.id, i.plan_id, i.due_on, i.amount_cents, i.transaction_id,
           ROW_NUMBER() OVER (PARTITION BY i.plan_id ORDER BY i.due_on, i.id)::int AS number,
           COUNT(*)     OVER (PARTITION BY i.plan_id)::int AS total,
           t.occurred_on AS paid_on, t.amount_cents AS paid_cents
    FROM payment_installments i
    LEFT JOIN transactions t ON t.id = i.transaction_id
    WHERE i.user_id = $1
  ) x`;

function shapeInstallment(row, today) {
  const paid = row.transaction_id != null;
  const st = installmentStatus({ dueOn: row.due_on, paid }, today);
  return {
    id: row.id,
    planId: row.plan_id,
    number: row.number,
    total: row.total,
    dueOn: row.due_on,
    amount: euros(row.amount_cents),
    paid,
    transactionId: row.transaction_id,
    paidOn: paid ? row.paid_on : null,
    paidAmount: paid ? euros(row.paid_cents) : null,
    status: st.status,
    daysOverdue: st.daysOverdue,
    daysToDue: st.daysToDue,
  };
}

/** Avanzamento di un piano dalle sue rate già in forma shape (in centesimi per non sommare float). */
function progressOf(insts) {
  const total = insts.length;
  const paidList = insts.filter((i) => i.paid);
  const cents = (e) => Math.round(e * 100);
  const paidCents = paidList.reduce((s, i) => s + cents(i.paidAmount), 0);
  const totalCents = insts.reduce((s, i) => s + cents(i.paid ? i.paidAmount : i.amount), 0);
  const next = insts.find((i) => !i.paid) || null;
  return {
    total,
    paidCount: paidList.length,
    percent: total ? Math.round((paidList.length / total) * 100) : 0,
    paidAmount: euros(paidCents),
    remainingAmount: euros(totalCents - paidCents),
    totalAmount: euros(totalCents),
    overdueCount: insts.filter((i) => i.status === 'overdue').length,
    completed: total > 0 && paidList.length === total,
    next: next && { id: next.id, number: next.number, dueOn: next.dueOn, amount: next.amount, status: next.status },
  };
}

const SELECT_PLAN = `
  SELECT p.*, c.name AS category_name, c.color AS category_color, a.name AS account_name
  FROM payment_plans p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN accounts   a ON a.id = p.account_id`;

function shapePlan(row, insts) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
    accountId: row.account_id,
    accountName: row.account_name,
    scope: row.scope,
    note: row.note,
    installments: insts,
    progress: progressOf(insts),
  };
}

async function loadPlans(userId, today, planId = null) {
  const plans = await query(`${SELECT_PLAN} WHERE p.user_id = $1${planId ? ' AND p.id = $2' : ''}`, planId ? [userId, planId] : [userId]);
  const inst = await query(`${INSTALLMENTS_SQL}${planId ? ' WHERE plan_id = $2' : ''} ORDER BY due_on, id`, planId ? [userId, planId] : [userId]);
  const byPlan = new Map();
  for (const r of inst.rows) {
    if (!byPlan.has(String(r.plan_id))) byPlan.set(String(r.plan_id), []);
    byPlan.get(String(r.plan_id)).push(shapeInstallment(r, today));
  }
  return plans.rows.map((p) => shapePlan(p, byPlan.get(String(p.id)) || []));
}

// In cima i piani con qualcosa da pagare (il più urgente per primo), in fondo i completati.
function sortPlans(plans) {
  const key = (p) => (p.progress.completed ? '9999-99-99' : p.progress.next?.dueOn || '9999-99-98');
  return plans.sort((a, b) => key(a).localeCompare(key(b)) || a.name.localeCompare(b.name));
}

router.get(
  '/',
  handler(async (req, res) => {
    const today = todayKey();
    res.json({ today, plans: sortPlans(await loadPlans(req.user.id, today)) });
  })
);

// Rate da segnalare: scadute o in scadenza oggi (alert) e, a parte, quelle dei prossimi `days` giorni.
// Una rata sparisce da qui appena ha un movimento collegato: nessuno stato da tenere allineato.
router.get(
  '/due',
  handler(async (req, res) => {
    const days = z.coerce.number().int().min(0).max(60).default(7).parse(req.query.days ?? 7);
    const today = todayKey();
    const rows = await query(
      `SELECT y.*, p.name AS plan_name, p.scope AS plan_scope, p.account_id AS plan_account_id, a.name AS plan_account_name,
              c.color AS category_color
       FROM (${INSTALLMENTS_SQL}) y
       JOIN payment_plans p ON p.id = y.plan_id
       LEFT JOIN accounts a ON a.id = p.account_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE y.transaction_id IS NULL AND y.due_on <= ($2::date + $3::int)
       ORDER BY y.due_on, y.plan_id, y.id`,
      [req.user.id, today, days]
    );
    const items = rows.rows.map((r) => ({
      ...shapeInstallment(r, today),
      planName: r.plan_name,
      scope: r.plan_scope,
      categoryColor: r.category_color,
      accountId: r.plan_account_id,
      accountName: r.plan_account_name,
    }));
    const alert = items.filter((i) => i.status === 'overdue' || i.status === 'today');
    const upcoming = items.filter((i) => i.status === 'upcoming');
    res.json({
      today,
      alert,
      upcoming,
      counts: { alert: alert.length, overdue: alert.filter((i) => i.status === 'overdue').length, upcoming: upcoming.length },
    });
  })
);

// Anteprima delle rate (non salva nulla): la creazione guidata la usa e poi lascia correggere le righe.
router.post(
  '/generate',
  handler(async (req, res) => {
    const input = generateInput.parse(req.body);
    const list = generateInstallments({
      count: input.count,
      firstDue: input.firstDue,
      everyMonths: input.everyMonths,
      mode: input.mode,
      amountCents: toCents(input.amount),
    });
    if (list.some((i) => i.amountCents <= 0)) {
      throw httpError(400, 'amount_too_small', 'L’importo totale è troppo basso per questo numero di rate');
    }
    res.json({ installments: list.map((i) => ({ dueOn: i.dueOn, amount: euros(i.amountCents) })) });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const input = createInput.parse(req.body);
    await assertCategory(req.user.id, input.categoryId ?? null, 'expense');
    await assertAccount(req.user.id, input.accountId ?? null);

    const planId = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO payment_plans (user_id, name, category_id, account_id, scope, note)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.user.id, input.name, input.categoryId ?? null, input.accountId ?? null, input.scope, input.note]
      );
      const id = ins.rows[0].id;
      await client.query(
        `INSERT INTO payment_installments (plan_id, user_id, due_on, amount_cents)
         SELECT $1, $2, d, a FROM unnest($3::date[], $4::bigint[]) AS t(d, a)`,
        [id, req.user.id, input.installments.map((i) => i.dueOn), input.installments.map((i) => toCents(i.amount))]
      );
      return id;
    });
    const [plan] = await loadPlans(req.user.id, todayKey(), planId);
    res.status(201).json({ plan });
  })
);

router.patch(
  '/installments/:iid',
  handler(async (req, res) => {
    const iid = idParam(req.params.iid);
    const patch = installmentInput.partial().parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    const cur = await query('SELECT plan_id, transaction_id FROM payment_installments WHERE id = $1 AND user_id = $2', [iid, req.user.id]);
    if (cur.rowCount === 0) throw httpError(404, 'not_found', 'Rata non trovata');
    if (cur.rows[0].transaction_id != null) {
      throw httpError(409, 'installment_paid', 'La rata è già pagata: modifica o elimina il movimento collegato');
    }
    await query(
      `UPDATE payment_installments
       SET due_on = COALESCE($3::date, due_on), amount_cents = COALESCE($4::bigint, amount_cents)
       WHERE id = $1 AND user_id = $2`,
      [iid, req.user.id, patch.dueOn ?? null, patch.amount != null ? toCents(patch.amount) : null]
    );
    const [plan] = await loadPlans(req.user.id, todayKey(), cur.rows[0].plan_id);
    res.json({ plan });
  })
);

router.delete(
  '/installments/:iid',
  handler(async (req, res) => {
    const iid = idParam(req.params.iid);
    const out = await withTransaction(async (client) => {
      const cur = await client.query(
        `SELECT i.plan_id, i.transaction_id,
                (SELECT COUNT(*)::int FROM payment_installments WHERE plan_id = i.plan_id) AS n
         FROM payment_installments i WHERE i.id = $1 AND i.user_id = $2 FOR UPDATE`,
        [iid, req.user.id]
      );
      if (cur.rowCount === 0) throw httpError(404, 'not_found', 'Rata non trovata');
      const r = cur.rows[0];
      if (r.transaction_id != null) {
        throw httpError(409, 'installment_paid', 'La rata è già pagata: elimina prima il movimento collegato');
      }
      if (r.n <= 1) throw httpError(409, 'last_installment', 'È l’ultima rata del piano: elimina il piano');
      await client.query('DELETE FROM payment_installments WHERE id = $1', [iid]);
      return r.plan_id;
    });
    const [plan] = await loadPlans(req.user.id, todayKey(), out);
    res.json({ plan });
  })
);

// Salda una rata: crea il movimento di spesa e lo collega, in un'unica transazione.
router.post(
  '/installments/:iid/pay',
  handler(async (req, res) => {
    const iid = idParam(req.params.iid);
    const input = payInput.parse(req.body ?? {});
    if (input.accountId != null) await assertAccount(req.user.id, input.accountId);

    const txId = await withTransaction(async (client) => {
      // Blocca la riga: due "Paga" simultanei non devono creare due movimenti.
      const lock = await client.query(
        'SELECT id, plan_id, amount_cents, transaction_id FROM payment_installments WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [iid, req.user.id]
      );
      if (lock.rowCount === 0) throw httpError(404, 'not_found', 'Rata non trovata');
      if (lock.rows[0].transaction_id != null) throw httpError(409, 'already_paid', 'La rata risulta già pagata');

      const info = await client.query(
        `SELECT p.name, p.category_id, p.account_id, p.scope, n.number, n.total
         FROM payment_plans p
         JOIN (${INSTALLMENTS_SQL} WHERE id = $2) n ON true
         WHERE p.id = $3`,
        [req.user.id, iid, lock.rows[0].plan_id]
      );
      const p = info.rows[0];
      const accountId = 'accountId' in input ? input.accountId : p.account_id;
      const note = input.note ?? `${p.name} ${p.number} di ${p.total}`;
      const amountCents = input.amount != null ? toCents(input.amount) : lock.rows[0].amount_cents;

      const tx = await client.query(
        `INSERT INTO transactions (user_id, type, amount_cents, category_id, account_id, scope, note, occurred_on)
         VALUES ($1, 'expense', $2, $3, $4, $5, $6, COALESCE($7::date, $8::date)) RETURNING id`,
        [req.user.id, amountCents, p.category_id, accountId ?? null, p.scope, note, input.occurredOn ?? null, todayKey()]
      );
      await client.query('UPDATE payment_installments SET transaction_id = $1 WHERE id = $2', [tx.rows[0].id, iid]);
      return tx.rows[0].id;
    });
    res.status(201).json({ ok: true, transactionId: txId });
  })
);

// Modifica del piano. `installments` (facoltativo) è l'elenco completo desiderato delle rate NON
// pagate: con `id` aggiorna quella rata, senza `id` ne aggiunge una, quelle non nominate vengono
// eliminate. Le rate già pagate non si toccano (si modificano dal movimento collegato).
const patchInput = planShape.partial().extend({
  installments: z.array(installmentInput.extend({ id: z.coerce.number().int().positive().optional() })).max(MAX_INSTALLMENTS).optional(),
});

router.patch(
  '/:id',
  handler(async (req, res) => {
    const id = idParam(req.params.id);
    const patch = patchInput.parse(req.body);
    if (Object.keys(patch).length === 0) throw httpError(400, 'empty_patch', 'Nessun campo da aggiornare');
    const cur = await query('SELECT category_id FROM payment_plans WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (cur.rowCount === 0) throw httpError(404, 'not_found', 'Piano non trovato');
    if ('categoryId' in patch && String(patch.categoryId ?? '') !== String(cur.rows[0].category_id ?? '')) {
      await assertCategory(req.user.id, patch.categoryId ?? null, 'expense');
    }
    if ('accountId' in patch) await assertAccount(req.user.id, patch.accountId ?? null);

    const sets = [];
    const vals = [id, req.user.id];
    const col = { name: 'name', categoryId: 'category_id', accountId: 'account_id', scope: 'scope', note: 'note' };
    for (const [k, c] of Object.entries(col)) {
      if (k in patch) {
        vals.push(patch[k] ?? (k === 'note' ? '' : null));
        sets.push(`${c} = $${vals.length}`);
      }
    }

    await withTransaction(async (client) => {
      if (sets.length) await client.query(`UPDATE payment_plans SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`, vals);
      if (!patch.installments) return;

      const rows = (await client.query('SELECT id, transaction_id FROM payment_installments WHERE plan_id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id])).rows;
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const paidCount = rows.filter((r) => r.transaction_id != null).length;
      const list = patch.installments;
      const seen = new Set();
      for (const it of list) {
        if (it.id == null) continue;
        const r = byId.get(String(it.id));
        if (!r || seen.has(String(it.id))) throw httpError(400, 'bad_installment', 'Rata non valida');
        if (r.transaction_id != null) throw httpError(409, 'installment_paid', 'Una rata già pagata non si modifica da qui: modifica il movimento collegato');
        seen.add(String(it.id));
      }
      if (paidCount + list.length < 1) throw httpError(400, 'no_installments', 'Il piano deve avere almeno una rata');
      if (paidCount + list.length > MAX_INSTALLMENTS) throw httpError(400, 'too_many', `Al massimo ${MAX_INSTALLMENTS} rate per piano`);

      const drop = rows.filter((r) => r.transaction_id == null && !seen.has(String(r.id))).map((r) => r.id);
      if (drop.length) await client.query('DELETE FROM payment_installments WHERE id = ANY($1::bigint[])', [drop]);
      const upd = list.filter((it) => it.id != null);
      if (upd.length) {
        await client.query(
          `UPDATE payment_installments i SET due_on = v.d, amount_cents = v.a
           FROM unnest($1::bigint[], $2::date[], $3::bigint[]) AS v(id, d, a) WHERE i.id = v.id`,
          [upd.map((it) => it.id), upd.map((it) => it.dueOn), upd.map((it) => toCents(it.amount))]
        );
      }
      const add = list.filter((it) => it.id == null);
      if (add.length) {
        await client.query(
          `INSERT INTO payment_installments (plan_id, user_id, due_on, amount_cents)
           SELECT $1, $2, d, a FROM unnest($3::date[], $4::bigint[]) AS t(d, a)`,
          [id, req.user.id, add.map((it) => it.dueOn), add.map((it) => toCents(it.amount))]
        );
      }
    });
    const [plan] = await loadPlans(req.user.id, todayKey(), id);
    res.json({ plan });
  })
);

// Aggiunge una rata a un piano esistente (es. conguaglio non previsto).
router.post(
  '/:id/installments',
  handler(async (req, res) => {
    const id = idParam(req.params.id);
    const input = installmentInput.parse(req.body);
    const own = await query(
      'SELECT (SELECT COUNT(*)::int FROM payment_installments WHERE plan_id = p.id) AS n FROM payment_plans p WHERE p.id = $1 AND p.user_id = $2',
      [id, req.user.id]
    );
    if (own.rowCount === 0) throw httpError(404, 'not_found', 'Piano non trovato');
    if (own.rows[0].n >= MAX_INSTALLMENTS) throw httpError(400, 'too_many', `Al massimo ${MAX_INSTALLMENTS} rate per piano`);
    await query('INSERT INTO payment_installments (plan_id, user_id, due_on, amount_cents) VALUES ($1, $2, $3, $4)', [
      id, req.user.id, input.dueOn, toCents(input.amount),
    ]);
    const [plan] = await loadPlans(req.user.id, todayKey(), id);
    res.status(201).json({ plan });
  })
);

// Rende uguali le rate NON ancora pagate (quelle pagate non si toccano):
//   mode 'each'  → ogni rata vale `amount`
//   mode 'total' → `amount` è il totale da dividere tra le rate da pagare (resto dei centesimi sull'ultima)
router.post(
  '/:id/equalize',
  handler(async (req, res) => {
    const id = idParam(req.params.id);
    const input = equalizeInput.parse(req.body);
    await withTransaction(async (client) => {
      const own = await client.query('SELECT 1 FROM payment_plans WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
      if (own.rowCount === 0) throw httpError(404, 'not_found', 'Piano non trovato');
      const open = await client.query(
        'SELECT id FROM payment_installments WHERE plan_id = $1 AND transaction_id IS NULL ORDER BY due_on, id',
        [id]
      );
      if (open.rowCount === 0) throw httpError(409, 'nothing_to_pay', 'Tutte le rate di questo piano sono già pagate');
      const cents = toCents(input.amount);
      const amounts = input.mode === 'total' ? splitAmount(cents, open.rowCount) : Array(open.rowCount).fill(cents);
      if (amounts.some((a) => a <= 0)) throw httpError(400, 'amount_too_small', 'L’importo totale è troppo basso per questo numero di rate');
      await client.query(
        `UPDATE payment_installments i SET amount_cents = v.a
         FROM unnest($1::bigint[], $2::bigint[]) AS v(id, a) WHERE i.id = v.id`,
        [open.rows.map((r) => r.id), amounts]
      );
    });
    const [plan] = await loadPlans(req.user.id, todayKey(), id);
    res.json({ plan });
  })
);

// Elimina il piano e le sue rate; i movimenti già registrati restano.
router.delete(
  '/:id',
  handler(async (req, res) => {
    const id = idParam(req.params.id);
    const del = await query('DELETE FROM payment_plans WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (del.rowCount === 0) throw httpError(404, 'not_found', 'Piano non trovato');
    res.json({ ok: true });
  })
);

module.exports = router;

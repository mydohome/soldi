'use strict';

// PR E — avanzamento delle spese fisse: calcolo puro (nessun database) e API.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installmentsDone, installmentProgress, recurringHits, scheduleEndMonth } = require('../src/recurring/schedule');

const monthly = (cursor, extra = {}) => ({
  cadence: 'monthly', month: null, total_occurrences: 12, amount_cents: 45000,
  start_month: '2026-05-01', last_run_month: cursor, ...extra,
});
const yearly = (cursor, extra = {}) => ({
  cadence: 'yearly', month: 3, total_occurrences: 3, amount_cents: 10000,
  start_month: '2026-01-01', last_run_month: cursor, ...extra,
});

describe('installmentsDone — mensile', () => {
  it('cursore NULL → 0', () => assert.equal(installmentsDone(monthly(null)), 0));
  it('cursore sul mese di partenza → 1', () => assert.equal(installmentsDone(monthly('2026-05-01')), 1));
  it('cursore 2026-09 → 5 (remaining 7)', () => {
    assert.equal(installmentsDone(monthly('2026-09-01')), 5);
    assert.equal(installmentProgress(monthly('2026-09-01'), 0).remaining, 7);
  });
  it('oltre la fine → limitato a N, completata', () => {
    assert.equal(installmentsDone(monthly('2027-06-01')), 12);
    assert.equal(installmentProgress(monthly('2027-06-01'), 0).completed, true);
  });
  it('start nel futuro con cursore NULL → 0; cursore precedente allo start → 0', () => {
    assert.equal(installmentsDone(monthly(null, { start_month: '2030-01-01' })), 0);
    assert.equal(installmentsDone(monthly('2026-09-01', { start_month: '2030-01-01' })), 0);
  });
  it('indefinita → 0 e progress null', () => {
    assert.equal(installmentsDone(monthly('2026-09-01', { total_occurrences: null })), 0);
    assert.equal(installmentProgress(monthly('2026-09-01', { total_occurrences: null }), 0), null);
  });
});

describe('installmentsDone — annuale', () => {
  it('mese 3, N=3, start 2026-01', () => {
    const got = ['2026-02-01', '2026-03-01', '2027-02-01', '2027-03-01', '2029-12-01'].map((c) => installmentsDone(yearly(c)));
    assert.deepEqual(got, [0, 1, 1, 2, 3]);
  });
  it('mese 3, start 2026-05 (primo anno 2027)', () => {
    const got = ['2026-12-01', '2027-03-01'].map((c) => installmentsDone(yearly(c, { start_month: '2026-05-01' })));
    assert.deepEqual(got, [0, 1]);
  });
  it('annuale senza mese (dato storico incoerente) → 0, senza eccezioni', () => {
    const r = yearly('2027-03-01', { month: null });
    assert.equal(installmentsDone(r), 0);
    assert.equal(installmentProgress(r, 0).endMonth, null);
  });
});

describe('installmentProgress', () => {
  it('importi in centesimi interi, convertiti alla fine', () => {
    const p = installmentProgress(monthly('2026-09-01'), 225000); // 450 € × 5 rate
    assert.equal(p.done, 5);
    assert.equal(p.remainingAmount, 3150);
    assert.equal(p.paid, 2250);
    assert.equal(p.planTotal, 5400);
    assert.equal(p.percent, 42);
    assert.equal(p.endMonth, '2027-04');
  });
  it('paid_cents come stringa (BIGINT di pg) e importi con decimali', () => {
    const p = installmentProgress(monthly('2026-05-01', { amount_cents: '1999' }), '1999');
    assert.equal(p.paid, 19.99);
    assert.equal(p.remainingAmount, 219.89); // 11 × 19,99
    assert.equal(p.planTotal, 239.88);
  });
});

describe('formula vs generate.js — la fine del piano coincide con l\'ultima rata', () => {
  it('per ogni N, il cursore sull\'ultimo mese dà done = N', () => {
    for (const [cadence, month, start] of [['monthly', null, '2026-05-01'], ['yearly', 3, '2026-05-01'], ['yearly', 3, '2026-03-01'], ['yearly', 11, '2026-03-01']]) {
      for (const n of [1, 2, 7]) {
        const rule = { cadence, month, total_occurrences: n, amount_cents: 100, start_month: start };
        const end = scheduleEndMonth(rule, start);
        assert.equal(installmentsDone({ ...rule, last_run_month: end }), n, `${cadence}/${month}/${start}/${n}`);
        const before = installmentsDone({ ...rule, last_run_month: `${end.slice(0, 4)}-${end.slice(5, 7)}-01`.replace(/^(\d+)-(\d+)/, (_, y, m) => (Number(m) === 1 ? `${Number(y) - 1}-12` : `${y}-${String(Number(m) - 1).padStart(2, '0')}`)) });
        assert.ok(before < n, 'il mese prima della fine non è ancora completo');
      }
    }
  });
  it('recurringHits (spostata da planned.js) mantiene il comportamento', () => {
    const r = { cadence: 'monthly', month: null, total_occurrences: 3, start_month: '2026-11-01' };
    assert.deepEqual(recurringHits(r, 2026).map(Number), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    assert.deepEqual(recurringHits(r, 2027).map(Number), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(recurringHits({ cadence: 'yearly', month: 3, total_occurrences: 2, start_month: '2026-05-01' }, 2027)[2], true);
    assert.equal(recurringHits({ cadence: 'yearly', month: 3, total_occurrences: 2, start_month: '2026-05-01' }, 2029)[2], false);
  });
});

describe('API /api/recurring — progress', () => {
  const h = require('./helpers');
  let server;
  before(async () => {
    await h.prepareDatabase();
    server = await h.startServer();
  });
  after(async () => {
    await server.stop();
    await h.closePool();
  });

  const monthKey = (offset) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  };

  // Regola inserita direttamente: start 4 mesi fa, 5 rate (da -4 a 0) già "scadute".
  async function seed(userId, over = {}) {
    const r = await h.query(
      `INSERT INTO recurring_rules (user_id, name, type, amount_cents, scope, cadence, day_of_month, total_occurrences, active, start_month, last_run_month)
       VALUES ($1, 'Finanziamento', 'expense', 45000, 'personal', 'monthly', 1, 12, true, $2, $3) RETURNING id`,
      [userId, over.start ?? monthKey(-4), over.cursor ?? monthKey(0)]
    );
    for (let i = 0; i < (over.movs ?? 5); i++) {
      await h.query(
        `INSERT INTO transactions (user_id, type, amount_cents, scope, recurring_rule_id, occurred_on, note)
         VALUES ($1, 'expense', 45000, 'personal', $2, $3, 'rata')`,
        [userId, r.rows[0].id, monthKey(-i)]
      );
    }
    return r.rows[0].id;
  }
  const rule = async (c, id) => (await c.get('/api/recurring')).body.rules.find((x) => x.id === id);

  it('450 € × 12, 5 rate: residuo 3150, planTotal = versato + residuo', async () => {
    const c = await h.registerUser(server.base, 'e1');
    const id = await seed(c.user.id);
    const p = (await rule(c, id)).progress;
    assert.equal(p.done, 5);
    assert.equal(p.remaining, 7);
    assert.equal(p.remainingAmount, 3150);
    assert.equal(p.paid, 2250);
    assert.equal(p.planTotal, 2250 + 3150);
    assert.equal(p.percent, 42);
    assert.equal(p.completed, false);
    assert.equal(p.endMonth, monthKey(-4 + 11).slice(0, 7));
    assert.equal((await rule(c, id)).occurrencesDone, 5); // campo storico invariato
  });

  it('eliminare un movimento generato: la barra non scende, "versato" sì', async () => {
    const c = await h.registerUser(server.base, 'e2');
    const id = await seed(c.user.id);
    const one = await h.query('SELECT id FROM transactions WHERE recurring_rule_id = $1 ORDER BY occurred_on LIMIT 1', [id]);
    assert.equal((await c.del(`/api/transactions/${one.rows[0].id}`)).status, 200);
    const r = await rule(c, id);
    assert.equal(r.occurrencesDone, 4);
    assert.equal(r.progress.done, 5);
    assert.equal(r.progress.percent, 42);
    assert.equal(r.progress.paid, 1800);
    assert.equal(r.progress.remainingAmount, 3150);
  });

  it('PATCH dell\'importo aggiorna residuo e totale; il versato resta quello reale', async () => {
    const c = await h.registerUser(server.base, 'e3');
    const id = await seed(c.user.id);
    const res = await c.patch(`/api/recurring/${id}`, { amount: 500 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.rule.progress;
    assert.equal(p.remainingAmount, 3500); // 7 × 500
    assert.equal(p.paid, 2250);
    assert.equal(p.planTotal, 5750);
    assert.equal((await rule(c, id)).progress.remainingAmount, 3500);
  });

  it('regola indefinita → progress: null; completata → completed', async () => {
    const c = await h.registerUser(server.base, 'e4');
    const created = await c.post('/api/recurring', { name: 'Abbonamento', amount: 10 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.rule.progress, null);

    const id = await seed(c.user.id, { start: monthKey(-20), cursor: monthKey(-9) });
    await h.query('UPDATE recurring_rules SET active = false WHERE id = $1', [id]);
    const p = (await rule(c, id)).progress;
    assert.equal(p.done, 12);
    assert.equal(p.completed, true);
    assert.equal(p.percent, 100);
    assert.equal(p.remainingAmount, 0);
  });

  it('isolamento: il versato conta solo i movimenti collegati alla regola', async () => {
    const c = await h.registerUser(server.base, 'e5');
    const id = await seed(c.user.id, { movs: 2 });
    await c.post('/api/transactions', { type: 'expense', amount: 999, occurredOn: monthKey(0) });
    assert.equal((await rule(c, id)).progress.paid, 900);
  });
});

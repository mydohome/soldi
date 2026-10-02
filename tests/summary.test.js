'use strict';

// Gruppo A — riepilogo e previsioni (planned.js, summary.js)

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
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

const tx = (c, body) => c.post('/api/transactions', body);

async function insertRule(userId, r) {
  await h.query(
    `INSERT INTO recurring_rules
       (user_id, name, type, amount_cents, scope, cadence, month, day_of_month,
        total_occurrences, active, start_month, last_run_month)
     VALUES ($1, $2, 'expense', $3, $4, $5, $6, 1, $7, true, $8, $8)`,
    [userId, r.name || 'regola', r.cents, r.scope || 'personal', r.cadence || 'monthly', r.month ?? null, r.total ?? null, r.start]
  );
}

describe('A1 — /api/planned/summary con scope', () => {
  it('risponde 200 con scope=home e scope=personal (colonna scope non ambigua)', async () => {
    const c = await h.registerUser(server.base, 'a1');
    assert.equal((await c.post('/api/planned', { name: 'Affitto', amount: 100, scope: 'home' })).status, 201);
    assert.equal((await c.post('/api/planned', { name: 'Assicurazione', amount: 120, cadence: 'yearly', month: 6, scope: 'personal' })).status, 201);
    await insertRule(c.user.id, { cents: 5000, scope: 'home', start: '2026-01-01' });
    assert.equal((await tx(c, { type: 'expense', amount: 30, scope: 'home', occurredOn: '2026-03-10' })).status, 201);
    assert.equal((await tx(c, { type: 'expense', amount: 20, scope: 'personal', occurredOn: '2026-04-10' })).status, 201);
    assert.equal((await tx(c, { type: 'income', amount: 999, scope: 'home', occurredOn: '2026-04-11' })).status, 201);

    const home = await c.get('/api/planned/summary?year=2026&scope=home');
    assert.equal(home.status, 200, JSON.stringify(home.body));
    assert.equal(home.body.totalPlanned, 1800); // 12×100 + 12×50
    assert.equal(home.body.totalActual, 30);
    assert.equal(home.body.scope, 'home');

    const personal = await c.get('/api/planned/summary?year=2026&scope=personal');
    assert.equal(personal.status, 200, JSON.stringify(personal.body));
    assert.equal(personal.body.totalPlanned, 120);
    assert.equal(personal.body.totalActual, 20);

    const homeNoRec = await c.get('/api/planned/summary?year=2026&scope=home&includeRecurring=false');
    assert.equal(homeNoRec.status, 200);
    assert.equal(homeNoRec.body.totalPlanned, 1200);

    const all = await c.get('/api/planned/summary?year=2026');
    assert.equal(all.status, 200);
    assert.equal(all.body.totalPlanned, 1920);
    assert.equal(all.body.totalActual, 50);
  });

  it('summary.js: overview e range con scope funzionano (nessuna colonna ambigua)', async () => {
    const c = await h.registerUser(server.base, 'a1s');
    await tx(c, { type: 'expense', amount: 30, scope: 'home', occurredOn: '2026-03-10' });
    await tx(c, { type: 'expense', amount: 20, scope: 'personal', occurredOn: '2026-03-12' });
    for (const scope of ['home', 'personal']) {
      const o = await c.get(`/api/summary/overview?anchor=2026-03-15&scope=${scope}`);
      assert.equal(o.status, 200, JSON.stringify(o.body));
      assert.equal(o.body.month.expense, scope === 'home' ? 30 : 20);
      const r = await c.get(`/api/summary/range?from=2026-03-01&to=2026-03-31&group=week&scope=${scope}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  });
});

describe('A2 — PATCH /api/planned/:id', () => {
  it('aggiorna parzialmente una voce (active / amount)', async () => {
    const c = await h.registerUser(server.base, 'a2');
    const created = await c.post('/api/planned', { name: 'Palestra', amount: 30 });
    assert.equal(created.status, 201);
    const id = created.body.planned.id;

    const off = await c.patch(`/api/planned/${id}`, { active: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.planned.active, false);

    const amt = await c.patch(`/api/planned/${id}`, { amount: 12.5 });
    assert.equal(amt.status, 200, JSON.stringify(amt.body));
    assert.equal(amt.body.planned.amount, 12.5);
    assert.equal(amt.body.planned.active, false); // invariato
    assert.equal(amt.body.planned.name, 'Palestra');
  });
});

describe('A3 — la previsione rispetta partenza e durata delle spese fisse', () => {
  const planned = (body) => body.months.map((m) => m.planned);

  it('regola mensile di 12 rate che parte a maggio 2026', async () => {
    const c = await h.registerUser(server.base, 'a3m');
    await insertRule(c.user.id, { cents: 10000, total: 12, start: '2026-05-01' });

    const y26 = await c.get('/api/planned/summary?year=2026');
    assert.equal(y26.status, 200);
    assert.deepEqual(planned(y26.body), [0, 0, 0, 0, 100, 100, 100, 100, 100, 100, 100, 100]);
    assert.equal(y26.body.totalPlanned, 800);
    assert.equal(y26.body.monthlyBudgetNeed, Number((800 / 12).toFixed(2)));

    const y27 = await c.get('/api/planned/summary?year=2027');
    assert.deepEqual(planned(y27.body), [100, 100, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(y27.body.totalPlanned, 400);

    const y28 = await c.get('/api/planned/summary?year=2028');
    assert.equal(y28.body.totalPlanned, 0);
  });

  it('regola mensile senza durata: da start_month in poi, mai prima', async () => {
    const c = await h.registerUser(server.base, 'a3i');
    await insertRule(c.user.id, { cents: 5000, start: '2026-09-01' });
    assert.equal((await c.get('/api/planned/summary?year=2025')).body.totalPlanned, 0);
    assert.equal((await c.get('/api/planned/summary?year=2026')).body.totalPlanned, 200); // set–dic
    assert.equal((await c.get('/api/planned/summary?year=2027')).body.totalPlanned, 600);
  });

  it('regola annuale (marzo) di 2 occorrenze con start gennaio 2026', async () => {
    const c = await h.registerUser(server.base, 'a3y');
    await insertRule(c.user.id, { cents: 24000, cadence: 'yearly', month: 3, total: 2, start: '2026-01-01' });
    const totals = [];
    for (const y of [2025, 2026, 2027, 2028]) totals.push((await c.get(`/api/planned/summary?year=${y}`)).body.totalPlanned);
    assert.deepEqual(totals, [0, 240, 240, 0]);
  });

  it('regola annuale con mese precedente a start_month: la prima occorrenza è l’anno dopo', async () => {
    const c = await h.registerUser(server.base, 'a3z');
    await insertRule(c.user.id, { cents: 24000, cadence: 'yearly', month: 3, total: 1, start: '2026-06-01' });
    const totals = [];
    for (const y of [2026, 2027, 2028]) totals.push((await c.get(`/api/planned/summary?year=${y}`)).body.totalPlanned);
    assert.deepEqual(totals, [0, 240, 0]);
  });
});

describe('A4 — avgMonthlyIncome usa solo i mesi completi', () => {
  it('non include il mese in corso', async () => {
    const c = await h.registerUser(server.base, 'a4');
    const now = new Date();
    const year = now.getUTCFullYear();
    const curMonth = now.getUTCMonth() + 1;
    const mm = (m) => String(m).padStart(2, '0');

    for (let m = 1; m < curMonth; m++) {
      assert.equal((await tx(c, { type: 'income', amount: 100, occurredOn: `${year}-${mm(m)}-15` })).status, 201);
    }
    assert.equal((await tx(c, { type: 'income', amount: 10000, occurredOn: `${year}-${mm(curMonth)}-01` })).status, 201);

    const r = await c.get(`/api/planned/summary?year=${year}`);
    assert.equal(r.status, 200);
    if (curMonth === 1) {
      assert.equal(r.body.avgMonthlyIncome, null);
      assert.equal(r.body.potentialMonthlySavings, null);
    } else {
      assert.equal(r.body.avgMonthlyIncome, 100);
      assert.equal(r.body.potentialMonthlySavings, Number((100 - r.body.monthlyBudgetNeed).toFixed(2)));
    }
  });
});

describe('A5 — media "vs 3 mesi" divisa per i mesi con dati', () => {
  const prevAvgOf = (body) => body.expenseByCategory.find((x) => x.categoryId != null).prevAvg;

  async function withCategory(c) {
    const { body } = await c.get('/api/categories');
    return body.categories.find((x) => x.kind === 'expense').id;
  }

  it('un solo mese di storico (300 €) → media 300, non 100', async () => {
    const c = await h.registerUser(server.base, 'a5a');
    const categoryId = await withCategory(c);
    await tx(c, { type: 'expense', amount: 300, categoryId, occurredOn: '2026-05-10' });
    await tx(c, { type: 'expense', amount: 50, categoryId, occurredOn: '2026-06-02' });
    const r = await c.get('/api/summary/overview?anchor=2026-06-15');
    assert.equal(r.status, 200);
    assert.equal(prevAvgOf(r.body), 300);
  });

  it('tre mesi pieni → media dei tre', async () => {
    const c = await h.registerUser(server.base, 'a5b');
    const categoryId = await withCategory(c);
    await tx(c, { type: 'expense', amount: 300, categoryId, occurredOn: '2026-03-10' });
    await tx(c, { type: 'expense', amount: 600, categoryId, occurredOn: '2026-04-10' });
    await tx(c, { type: 'expense', amount: 900, categoryId, occurredOn: '2026-05-10' });
    await tx(c, { type: 'expense', amount: 50, categoryId, occurredOn: '2026-06-02' });
    const r = await c.get('/api/summary/overview?anchor=2026-06-15');
    assert.equal(prevAvgOf(r.body), 600);
  });

  it('con filtro scope la media considera solo quello scope', async () => {
    const c = await h.registerUser(server.base, 'a5c');
    const categoryId = await withCategory(c);
    await tx(c, { type: 'expense', amount: 300, categoryId, scope: 'home', occurredOn: '2026-05-10' });
    await tx(c, { type: 'expense', amount: 50, categoryId, scope: 'home', occurredOn: '2026-06-02' });
    const r = await c.get('/api/summary/overview?anchor=2026-06-15&scope=home');
    assert.equal(r.status, 200);
    assert.equal(prevAvgOf(r.body), 300);
  });
});

describe('A6 — /api/summary/range limita l’intervallo', () => {
  it('rifiuta intervalli enormi e to < from con 400', async () => {
    const c = await h.registerUser(server.base, 'a6');
    assert.equal((await c.get('/api/summary/range?from=1900-01-01&to=2100-01-01&group=day')).status, 400);
    assert.equal((await c.get('/api/summary/range?from=1900-01-01&to=2100-01-01&group=week')).status, 400);
    assert.equal((await c.get('/api/summary/range?from=2026-03-01&to=2026-01-01')).status, 400);
  });

  it('accetta intervalli ragionevoli', async () => {
    const c = await h.registerUser(server.base, 'a6ok');
    const days = await c.get('/api/summary/range?from=2026-01-01&to=2026-03-31&group=day');
    assert.equal(days.status, 200);
    assert.equal(days.body.series.length, 90);
    const months = await c.get('/api/summary/range?from=2000-01-01&to=2026-12-31&group=month');
    assert.equal(months.status, 200);
    assert.equal(months.body.series.length, 27 * 12);
    // esattamente al limite (800 giorni) è ancora valido
    const edge = await c.get('/api/summary/range?from=2024-01-01&to=2026-03-10&group=day');
    assert.equal(edge.status, 200);
  });
});

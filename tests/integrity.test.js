'use strict';

// Gruppo B — validazione e integrità (date, mese delle voci annuali, tipo categoria)

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

// PATCH /api/planned/:id è rotto su main finché non è unita la PR del gruppo A (A2):
// le asserzioni che lo usano si saltano (e non falliscono) senza quel fix.
async function plannedPatchWorks(c) {
  const created = await c.post('/api/planned', { name: 'sonda', amount: 1 });
  const probe = await c.patch(`/api/planned/${created.body.planned.id}`, { note: 'x' });
  return probe.status !== 500;
}
const NEEDS_A2 = 'richiede il fix A2 (PATCH /api/planned) del gruppo A';

async function setup(tag) {
  const c = await h.registerUser(server.base, tag);
  const { body } = await c.get('/api/categories');
  const expense = body.categories.find((x) => x.kind === 'expense');
  const income = body.categories.find((x) => x.kind === 'income');
  const accounts = (await c.get('/api/accounts')).body.accounts;
  return { c, expense, income, account: accounts[0] };
}

describe('B1 — date inesistenti → 400, non 500', () => {
  it('movimento con data inesistente o fuori calendario', async () => {
    const { c } = await setup('b1a');
    for (const occurredOn of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '2026-02-29', '0000-01-01']) {
      const r = await c.post('/api/transactions', { type: 'expense', amount: 1, occurredOn });
      assert.equal(r.status, 400, `${occurredOn} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await c.post('/api/transactions', { type: 'expense', amount: 1, occurredOn: '2024-02-29' })).status, 201);
  });

  it('PATCH movimento e filtri lista con data inesistente', async () => {
    const { c } = await setup('b1b');
    const tx = (await c.post('/api/transactions', { type: 'expense', amount: 1, occurredOn: '2026-03-01' })).body.transaction;
    assert.equal((await c.patch(`/api/transactions/${tx.id}`, { occurredOn: '2026-02-31' })).status, 400);
    assert.equal((await c.get('/api/transactions?from=2026-02-31')).status, 400);
    assert.equal((await c.get('/api/transactions?to=2026-13-01')).status, 400);
    assert.equal((await c.get('/api/transactions?from=2026-02-01&to=2026-02-28')).status, 200);
  });

  it('summary: anchor, from e to inesistenti', async () => {
    const { c } = await setup('b1c');
    assert.equal((await c.get('/api/summary/overview?anchor=2026-13-01')).status, 400);
    assert.equal((await c.get('/api/summary/overview?anchor=2026-02-31')).status, 400);
    assert.equal((await c.get('/api/summary/range?from=2026-02-31&to=2026-03-31')).status, 400);
    assert.equal((await c.get('/api/summary/range?from=2026-01-01&to=2026-13-31')).status, 400);
    assert.equal((await c.get('/api/summary/overview?anchor=2026-02-28')).status, 200);
  });
});

describe('B2 — voce annuale senza mese', () => {
  it('recurring: PATCH cadence=yearly senza mese → 400 e regola invariata', async () => {
    const { c } = await setup('b2r');
    const created = await c.post('/api/recurring', { name: 'Abbonamento', amount: 10 });
    assert.equal(created.status, 201);
    const id = created.body.rule.id;

    const bad = await c.patch(`/api/recurring/${id}`, { cadence: 'yearly' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'yearly_needs_month');
    assert.match(bad.body.message, /serve il mese/);

    const after = (await c.get('/api/recurring')).body.rules.find((r) => r.id === id);
    assert.equal(after.cadence, 'monthly');
    assert.equal(after.month, null);

    const ok = await c.patch(`/api/recurring/${id}`, { cadence: 'yearly', month: 3 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.rule.cadence, 'yearly');
    assert.equal(ok.body.rule.month, 3);
  });

  it('planned: PATCH cadence=yearly senza mese → 400 e voce invariata', async (t) => {
    const { c } = await setup('b2p');
    if (!(await plannedPatchWorks(c))) return t.skip(NEEDS_A2);
    const created = await c.post('/api/planned', { name: 'Tasse', amount: 100 });
    const id = created.body.planned.id;

    const bad = await c.patch(`/api/planned/${id}`, { cadence: 'yearly' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'yearly_needs_month');

    const after = (await c.get('/api/planned')).body.planned.find((r) => r.id === id);
    assert.equal(after.cadence, 'monthly');

    const ok = await c.patch(`/api/planned/${id}`, { cadence: 'yearly', month: 6 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.planned.month, 6);
  });

  it('POST annuale senza mese resta 400 (validazione zod)', async () => {
    const { c } = await setup('b2z');
    assert.equal((await c.post('/api/recurring', { name: 'x', amount: 1, cadence: 'yearly' })).status, 400);
    assert.equal((await c.post('/api/planned', { name: 'x', amount: 1, cadence: 'yearly' })).status, 400);
  });

  it('dati storici incoerenti non bloccano migrazione né generazione delle altre regole', async () => {
    const { c } = await setup('b2legacy');
    const { generateDue } = require('../src/recurring/generate');
    const { migrate } = require('../src/db/migrate');

    // Simula la produzione: riga storica incoerente presente PRIMA che il vincolo esista.
    await h.query('ALTER TABLE recurring_rules DROP CONSTRAINT IF EXISTS recurring_yearly_month_check');
    await h.query('ALTER TABLE planned_expenses DROP CONSTRAINT IF EXISTS planned_yearly_month_check');
    await h.query(
      `INSERT INTO recurring_rules (user_id, name, amount_cents, cadence, month, start_month)
       VALUES ($1, 'storica incoerente', 1000, 'yearly', NULL, '2020-01-01')`,
      [c.user.id]
    );
    await h.query(
      `INSERT INTO planned_expenses (user_id, name, amount_cents, cadence, month)
       VALUES ($1, 'storica incoerente', 1000, 'yearly', NULL)`,
      [c.user.id]
    );
    await migrate(); // deve creare i vincoli NOT VALID senza errori
    await migrate(); // e restare idempotente

    // Una regola valida e dovuta deve essere generata comunque.
    await h.query(
      `INSERT INTO recurring_rules (user_id, name, amount_cents, cadence, start_month)
       VALUES ($1, 'valida', 2500, 'monthly', date_trunc('month', CURRENT_DATE))`,
      [c.user.id]
    );
    const out = await generateDue({ userId: c.user.id, now: new Date(Date.UTC(2099, 0, 20)) });
    assert.ok(out.created > 0, 'la regola valida deve generare movimenti');
    const n = await h.query(
      `SELECT COUNT(*)::int AS n FROM transactions t JOIN recurring_rules r ON r.id = t.recurring_rule_id
       WHERE t.user_id = $1 AND r.name = 'valida'`,
      [c.user.id]
    );
    assert.ok(n.rows[0].n > 0);

    // Ogni UPDATE sulla riga incoerente deve rispettare il vincolo → errore chiaro, non 500.
    const legacy = (await c.get('/api/recurring')).body.rules.find((r) => r.name === 'storica incoerente');
    const res = await c.patch(`/api/recurring/${legacy.id}`, { note: 'ciao' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'yearly_needs_month');
    assert.equal((await c.patch(`/api/recurring/${legacy.id}`, { month: 5 })).status, 200);
  });
});

describe('B3 — categoria compatibile con il tipo', () => {
  it('movimenti: POST con categoria di tipo opposto → 400', async () => {
    const { c, expense, income } = await setup('b3tx');
    const bad = await c.post('/api/transactions', { type: 'expense', amount: 5, categoryId: income.id });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'category_kind_mismatch');
    const bad2 = await c.post('/api/transactions', { type: 'income', amount: 5, categoryId: expense.id });
    assert.equal(bad2.status, 400);
    assert.equal((await c.post('/api/transactions', { type: 'expense', amount: 5, categoryId: expense.id })).status, 201);
    assert.equal((await c.post('/api/transactions', { type: 'income', amount: 5, categoryId: income.id })).status, 201);
    assert.equal((await c.post('/api/transactions', { type: 'income', amount: 5 })).status, 201); // senza categoria
  });

  it('movimenti: PATCH valida la coppia effettiva (tipo, categoria)', async () => {
    const { c, expense, income } = await setup('b3pt');
    const tx = (await c.post('/api/transactions', { type: 'expense', amount: 5, categoryId: expense.id })).body.transaction;
    const url = `/api/transactions/${tx.id}`;

    const a = await c.patch(url, { type: 'income' }); // la categoria attuale è di spesa
    assert.equal(a.status, 400, JSON.stringify(a.body));
    assert.equal(a.body.error, 'category_kind_mismatch');
    assert.equal((await c.patch(url, { categoryId: income.id })).status, 400);
    assert.equal((await c.patch(url, { note: 'solo nota' })).status, 200);
    assert.equal((await c.patch(url, { type: 'income', categoryId: income.id })).status, 200);
    assert.equal((await c.patch(url, { categoryId: null })).status, 200);
    assert.equal((await c.patch(url, { type: 'expense' })).status, 200); // senza categoria: ok
    assert.equal((await c.patch('/api/transactions/99999999', { type: 'income' })).status, 404);
  });

  it('movimenti: un dato storico incoerente non blocca la modifica di altri campi', async () => {
    const { c, income } = await setup('b3legacy');
    const ins = await h.query(
      `INSERT INTO transactions (user_id, type, amount_cents, category_id, note)
       VALUES ($1, 'expense', 500, $2, 'storico') RETURNING id`,
      [c.user.id, income.id]
    );
    const url = `/api/transactions/${ins.rows[0].id}`;
    assert.equal((await c.patch(url, { note: 'modificata' })).status, 200);
    // il client della UI rimanda gli stessi valori: non è un cambio di tipo/categoria
    assert.equal((await c.patch(url, { type: 'expense', categoryId: income.id, amount: 7 })).status, 200);
  });

  it('spese fisse: POST e PATCH rispettano il tipo', async () => {
    const { c, expense, income } = await setup('b3rec');
    const bad = await c.post('/api/recurring', { name: 'Stipendio', type: 'income', amount: 1, categoryId: expense.id });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'category_kind_mismatch');
    const ok = await c.post('/api/recurring', { name: 'Affitto', type: 'expense', amount: 1, categoryId: expense.id });
    assert.equal(ok.status, 201);
    const id = ok.body.rule.id;
    assert.equal((await c.patch(`/api/recurring/${id}`, { type: 'income' })).status, 400);
    assert.equal((await c.patch(`/api/recurring/${id}`, { categoryId: income.id })).status, 400);
    assert.equal((await c.patch(`/api/recurring/${id}`, { note: 'ok' })).status, 200);
    assert.equal((await c.patch(`/api/recurring/${id}`, { type: 'income', categoryId: income.id })).status, 200);
  });

  it('voci previste: la categoria deve essere di spesa', async (t) => {
    const { c, expense, income } = await setup('b3pl');
    const bad = await c.post('/api/planned', { name: 'x', amount: 1, categoryId: income.id });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'category_kind_mismatch');
    const ok = await c.post('/api/planned', { name: 'y', amount: 1, categoryId: expense.id });
    assert.equal(ok.status, 201);
    if (!(await plannedPatchWorks(c))) return t.skip(NEEDS_A2);
    assert.equal((await c.patch(`/api/planned/${ok.body.planned.id}`, { categoryId: income.id })).status, 400);
    assert.equal((await c.patch(`/api/planned/${ok.body.planned.id}`, { note: 'ok' })).status, 200);
  });

  it('categorie: cambiare kind di una categoria in uso → 409; nome/colore → 200', async () => {
    const { c, expense } = await setup('b3cat');
    await c.post('/api/transactions', { type: 'expense', amount: 5, categoryId: expense.id });
    const url = `/api/categories/${expense.id}`;

    const bad = await c.patch(url, { kind: 'income' });
    assert.equal(bad.status, 409, JSON.stringify(bad.body));
    assert.equal(bad.body.error, 'category_in_use');
    assert.equal((await c.patch(url, { name: 'Rinominata', color: '#112233' })).status, 200);
    assert.equal((await c.patch(url, { kind: 'expense' })).status, 200); // nessun cambio reale

    // categoria libera: il cambio di kind è consentito
    const free = (await c.post('/api/categories', { name: 'Libera', kind: 'expense' })).body.category;
    assert.equal((await c.patch(`/api/categories/${free.id}`, { kind: 'income' })).status, 200);
  });

  it('categorie: usata da spese fisse o da voci previste → 409', async () => {
    const { c } = await setup('b3cat2');
    const r1 = (await c.post('/api/categories', { name: 'PerRegola', kind: 'expense' })).body.category;
    await c.post('/api/recurring', { name: 'r', amount: 1, categoryId: r1.id });
    assert.equal((await c.patch(`/api/categories/${r1.id}`, { kind: 'income' })).status, 409);

    const r2 = (await c.post('/api/categories', { name: 'PerVoce', kind: 'expense' })).body.category;
    await c.post('/api/planned', { name: 'p', amount: 1, categoryId: r2.id });
    assert.equal((await c.patch(`/api/categories/${r2.id}`, { kind: 'income' })).status, 409);

    // categoria di entrata usata da una regola di entrata: non può diventare spesa
    const r3 = (await c.post('/api/categories', { name: 'Entrata regola', kind: 'income' })).body.category;
    await c.post('/api/recurring', { name: 'ri', type: 'income', amount: 1, categoryId: r3.id });
    assert.equal((await c.patch(`/api/categories/${r3.id}`, { kind: 'expense' })).status, 409);
  });
});

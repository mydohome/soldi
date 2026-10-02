'use strict';

// Gruppo D — isolamento tra utenti: l'utente B non deve poter leggere, modificare,
// eliminare né referenziare nessuna risorsa dell'utente A, per ogni rotta che
// accetta un ID (categoria, conto, regola, movimento, voce prevista, backup).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

let server;
let A;
let B;
const ids = {};
const SECRET = 'segreto-di-A';

before(async () => {
  await h.prepareDatabase();
  server = await h.startServer();
  A = await h.registerUser(server.base, 'iso-a');
  B = await h.registerUser(server.base, 'iso-b');

  ids.cat = (await A.post('/api/categories', { name: 'CatA', kind: 'expense' })).body.category.id;
  ids.acc = (await A.post('/api/accounts', { name: 'ContoA' })).body.account.id;
  ids.tx = (
    await A.post('/api/transactions', {
      type: 'expense', amount: 100, categoryId: ids.cat, accountId: ids.acc, note: SECRET, occurredOn: '2026-05-10',
    })
  ).body.transaction.id;
  const rule = await A.post('/api/recurring', { name: 'RegolaA', amount: 20, categoryId: ids.cat, accountId: ids.acc });
  ids.rule = rule.body.rule.id;
  ids.planned = (await A.post('/api/planned', { name: 'VoceA', amount: 50, categoryId: ids.cat })).body.planned.id;
  ids.backup = (await A.post('/api/backups')).body.created;
  assert.ok(ids.cat && ids.acc && ids.tx && ids.rule && ids.planned && ids.backup, JSON.stringify(ids));
});
after(async () => {
  await server.stop();
  await h.closePool();
});

const snapshotOfA = async () => ({
  categories: (await A.get('/api/categories')).body.categories.map((c) => `${c.id}:${c.name}:${c.kind}:${c.tx_count}`),
  accounts: (await A.get('/api/accounts')).body.accounts.map((c) => `${c.id}:${c.name}:${c.tx_count}`),
  transactions: (await A.get('/api/transactions?limit=500')).body.transactions.map((t) => `${t.id}:${t.note}:${t.amount}:${t.categoryId}`),
  recurring: (await A.get('/api/recurring')).body.rules.map((r) => `${r.id}:${r.name}:${r.active}`),
  planned: (await A.get('/api/planned')).body.planned.map((p) => `${p.id}:${p.name}:${p.active}`),
  backups: (await A.get('/api/backups')).body.backups.map((b) => b.name),
});

describe('D — nessuna rotta è raggiungibile senza sessione', () => {
  it('401 senza cookie', async () => {
    const anon = new h.Client(server.base, null, null);
    for (const url of [
      '/api/transactions', '/api/categories', '/api/accounts', '/api/recurring', '/api/planned',
      '/api/planned/summary', '/api/summary/overview', '/api/summary/range?from=2026-01-01&to=2026-01-31',
      '/api/savings', '/api/backups', '/api/settings/version', '/api/settings/check-update', '/api/auth/me',
    ]) {
      assert.equal((await anon.get(url)).status, 401, url);
    }
    assert.equal((await anon.post('/api/backups')).status, 401);
    assert.equal((await anon.post(`/api/backups/${ids.backup}/restore`)).status, 401);
    assert.equal((await anon.post('/api/settings/update')).status, 401);
  });
});

describe('D — B non vede le risorse di A', () => {
  it('le liste di B sono vuote o contengono solo roba di B', async () => {
    const cats = (await B.get('/api/categories')).body.categories;
    assert.ok(!cats.some((c) => c.id === ids.cat || c.name === 'CatA'));
    const accs = (await B.get('/api/accounts')).body.accounts;
    assert.ok(!accs.some((a) => a.id === ids.acc || a.name === 'ContoA'));
    assert.deepEqual((await B.get('/api/transactions')).body.transactions, []);
    assert.deepEqual((await B.get('/api/recurring')).body.rules, []);
    assert.deepEqual((await B.get('/api/planned')).body.planned, []);
    assert.deepEqual((await B.get('/api/backups')).body.backups, []);
  });

  it('i filtri per ID di A non restituiscono nulla; la ricerca testo non trova i movimenti di A', async () => {
    assert.deepEqual((await B.get(`/api/transactions?categoryId=${ids.cat}`)).body.transactions, []);
    assert.deepEqual((await B.get(`/api/transactions?accountId=${ids.acc}`)).body.transactions, []);
    assert.deepEqual((await B.get(`/api/transactions?q=${SECRET}`)).body.transactions, []);
    assert.equal(JSON.stringify((await B.get('/api/transactions/suggest?note=segreto')).body).includes(SECRET), false);
  });

  it('riepiloghi e previsioni di B non includono i dati di A', async () => {
    const o = (await B.get('/api/summary/overview?anchor=2026-05-15')).body;
    assert.equal(o.month.expense, 0);
    assert.deepEqual(o.expenseByCategory, []);
    const r = (await B.get('/api/summary/range?from=2026-05-01&to=2026-05-31&group=day')).body;
    assert.ok(r.series.every((p) => p.expense === 0 && p.income === 0));
    const p = (await B.get('/api/planned/summary?year=2026')).body;
    assert.equal(p.totalPlanned, 0);
    assert.equal(p.totalActual, 0);
    assert.deepEqual(p.byCategory, []);
    // …mentre quelli di A sì (sanità del test)
    assert.equal((await A.get('/api/summary/overview?anchor=2026-05-15')).body.month.expense, 100);
  });
});

describe('D — B non può modificare né eliminare le risorse di A', () => {
  it('PATCH e DELETE su ID di A → 404 e A resta intatto', async () => {
    const before = await snapshotOfA();
    const attempts = [
      ['patch', `/api/transactions/${ids.tx}`, { note: 'hackerato' }],
      ['delete', `/api/transactions/${ids.tx}`],
      ['patch', `/api/recurring/${ids.rule}`, { active: false }],
      ['delete', `/api/recurring/${ids.rule}`],
      ['patch', `/api/categories/${ids.cat}`, { name: 'Rubata' }],
      ['delete', `/api/categories/${ids.cat}`],
      ['patch', `/api/accounts/${ids.acc}`, { name: 'Rubato' }],
      ['delete', `/api/accounts/${ids.acc}`],
      ['delete', `/api/planned/${ids.planned}`],
    ];
    for (const [method, url, body] of attempts) {
      const res = method === 'delete' ? await B.del(url) : await B.patch(url, body);
      assert.equal(res.status, 404, `${method.toUpperCase()} ${url} → ${res.status} ${JSON.stringify(res.body)}`);
    }
    assert.deepEqual(await snapshotOfA(), before);
  });

  it('PATCH di una voce prevista di A → 404', async (t) => {
    // PATCH /api/planned è rotto su main finché non c'è il fix A2 del gruppo A: si salta.
    const own = await B.post('/api/planned', { name: 'sonda', amount: 1 });
    if ((await B.patch(`/api/planned/${own.body.planned.id}`, { note: 'x' })).status === 500) {
      return t.skip('richiede il fix A2 (PATCH /api/planned) del gruppo A');
    }
    assert.equal((await B.patch(`/api/planned/${ids.planned}`, { active: false })).status, 404);
    assert.equal((await A.get('/api/planned')).body.planned[0].active, true);
  });

  it('DELETE della regola di A da parte di B non cancella i movimenti generati per A', async () => {
    const withRule = (await A.get('/api/transactions')).body.transactions.filter((t) => t.recurringRuleId === ids.rule);
    assert.ok(withRule.length > 0, 'la regola di A deve aver generato almeno un movimento');
    assert.equal((await B.del(`/api/recurring/${ids.rule}`)).status, 404);
    assert.equal((await B.del(`/api/recurring/${ids.rule}?keepMovimenti=false`)).status, 404);
    const after = (await A.get('/api/transactions')).body.transactions.filter((t) => t.recurringRuleId === ids.rule);
    assert.equal(after.length, withRule.length);
  });

  it('"Esegui adesso" di B non genera né tocca i movimenti di A', async () => {
    const before = (await A.get('/api/transactions?limit=500')).body.transactions.length;
    assert.equal((await B.post('/api/recurring/run')).status, 200);
    assert.equal((await A.get('/api/transactions?limit=500')).body.transactions.length, before);
    assert.equal((await B.get('/api/transactions')).body.transactions.length, 0);
  });

  it('le impostazioni di risparmio sono per utente', async () => {
    assert.equal((await B.patch('/api/savings', { emergencyMonths: 9, emergencySplit: 10 })).status, 200);
    const a = (await A.get('/api/savings')).body;
    const b = (await B.get('/api/savings')).body;
    assert.notDeepEqual(JSON.stringify(a.settings ?? a), JSON.stringify(b.settings ?? b));
    assert.equal(JSON.stringify(a).includes('"emergencyMonths":9'), false);
  });
});

describe('D — B non può referenziare le risorse di A', () => {
  it('movimento, spesa fissa e voce prevista con categoria/conto di A → 400', async () => {
    const ownCat = (await B.get('/api/categories')).body.categories.find((c) => c.kind === 'expense').id;
    const tx = (path, body) => B.post(path, body);

    let r = await tx('/api/transactions', { type: 'expense', amount: 1, categoryId: ids.cat });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_category');
    r = await tx('/api/transactions', { type: 'expense', amount: 1, accountId: ids.acc });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_account');
    r = await tx('/api/recurring', { name: 'x', amount: 1, categoryId: ids.cat });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_category');
    r = await tx('/api/recurring', { name: 'x', amount: 1, accountId: ids.acc });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_account');
    r = await tx('/api/planned', { name: 'x', amount: 1, categoryId: ids.cat });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_category');

    // PATCH di risorse proprie verso risorse di A
    const mine = (await B.post('/api/transactions', { type: 'expense', amount: 5, categoryId: ownCat })).body.transaction;
    assert.equal((await B.patch(`/api/transactions/${mine.id}`, { categoryId: ids.cat })).status, 400);
    assert.equal((await B.patch(`/api/transactions/${mine.id}`, { accountId: ids.acc })).status, 400);
    const rule = (await B.post('/api/recurring', { name: 'mia', amount: 1 })).body.rule;
    assert.equal((await B.patch(`/api/recurring/${rule.id}`, { categoryId: ids.cat })).status, 400);
    assert.equal((await B.patch(`/api/recurring/${rule.id}`, { accountId: ids.acc })).status, 400);

    // nulla è cambiato per le risorse di B né per quelle di A
    assert.equal((await B.get('/api/transactions')).body.transactions.find((t) => t.id === mine.id).categoryId, String(ownCat));
    assert.equal((await A.get('/api/categories')).body.categories.find((c) => c.id === ids.cat).tx_count, 2); // movimento + generato dalla regola
  });
});

describe('D — backup', () => {
  it('B non può ripristinare il backup di A (404) e non lo vede', async () => {
    const bBefore = (await B.get('/api/transactions')).body.transactions.length;
    const r = await B.post(`/api/backups/${ids.backup}/restore`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal((await B.get('/api/transactions')).body.transactions.length, bBefore);
    assert.ok(!(await B.get('/api/backups')).body.backups.some((b) => b.name === ids.backup));
  });

  it('il backup di B non contiene dati di A e il ripristino di B non tocca A', async () => {
    const created = await B.post('/api/backups');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const dir = path.join(server.backupDir, created.body.created);
    for (const f of fs.readdirSync(dir)) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.equal(content.includes(SECRET), false, `${f} contiene dati di A`);
      assert.equal(content.includes('CatA'), false, `${f} contiene la categoria di A`);
      assert.equal(content.includes('ContoA'), false, `${f} contiene il conto di A`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.userId, B.user.id);
    assert.equal(manifest.tables.users, undefined);

    const aBefore = await snapshotOfA();
    await B.post('/api/transactions', { type: 'income', amount: 7 });
    const restored = await B.post(`/api/backups/${created.body.created}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(await snapshotOfA(), aBefore);
  });

  it('A vede solo i propri backup e il proprio ripristino funziona', async () => {
    const list = (await A.get('/api/backups')).body.backups;
    assert.deepEqual(list.map((b) => b.name), [ids.backup]);
    assert.equal((await A.post(`/api/backups/${ids.backup}/restore`)).status, 200);
    assert.equal((await A.get('/api/transactions?q=' + SECRET)).body.transactions.length, 1);
  });
});

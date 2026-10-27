'use strict';

// Pagamenti programmati ("Da pagare"): calendario delle rate, API, collegamento col movimento,
// elenco delle scadenze da segnalare, isolamento tra utenti, backup/ripristino.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');

const { addMonthsClamped, daysBetween, generateInstallments, installmentStatus, todayKey } = require('../src/payments/schedule');
const core = require('../src/backup/backup-core');
const { restoreUserBackup } = require('../src/backup/restore-user');

let server;
before(async () => {
  await h.prepareDatabase();
  server = await h.startServer();
});
after(async () => {
  await server.stop();
  await h.closePool();
});

// Il limite di registrazioni del server (20 ogni 15 minuti) impone di riusare gli utenti: ogni
// richiesta riparte da dati puliti (movimenti e piani dell'utente eliminati).
const users = {};
async function user(tag) {
  users[tag] ||= await h.registerUser(server.base, `pay-${tag}`);
  const id = users[tag].user.id;
  await h.query('DELETE FROM payment_plans WHERE user_id = $1', [id]);
  await h.query('DELETE FROM transactions WHERE user_id = $1', [id]);
  return users[tag];
}

const day = (offset) => {
  const t = todayKey();
  const d = new Date(`${t}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function expenseCat(c) {
  const { categories } = (await c.get('/api/categories')).body;
  return categories.find((x) => x.kind === 'expense');
}
async function makePlan(c, offsets = [-3, 0, 5, 40], over = {}) {
  const cat = await expenseCat(c);
  const res = await c.post('/api/payments', {
    name: 'Condominio lavori',
    categoryId: cat.id,
    scope: 'home',
    installments: offsets.map((o, i) => ({ dueOn: day(o), amount: 100 + i })),
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.plan;
}
const dueOf = async (c, days = 7) => (await c.get(`/api/payments/due?days=${days}`)).body;

describe('calendario (modulo puro)', () => {
  it('addMonthsClamped non esce dal mese e parte sempre dalla data originale', () => {
    assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsClamped('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonthsClamped('2026-01-31', 2), '2026-03-31');
    assert.equal(addMonthsClamped('2026-11-15', 3), '2027-02-15');
    assert.equal(addMonthsClamped('2026-12-10', 1), '2027-01-10');
  });
  it('generateInstallments: rate uguali oppure totale diviso con il resto sull’ultima', () => {
    const each = generateInstallments({ count: 3, firstDue: '2026-11-15', everyMonths: 1, mode: 'each', amountCents: 5000 });
    assert.deepEqual(each.map((i) => i.dueOn), ['2026-11-15', '2026-12-15', '2027-01-15']);
    assert.deepEqual(each.map((i) => i.amountCents), [5000, 5000, 5000]);
    const total = generateInstallments({ count: 3, firstDue: '2026-11-15', everyMonths: 2, mode: 'total', amountCents: 10000 });
    assert.deepEqual(total.map((i) => i.amountCents), [3333, 3333, 3334]);
    assert.equal(total.reduce((s, i) => s + i.amountCents, 0), 10000);
    assert.deepEqual(total.map((i) => i.dueOn), ['2026-11-15', '2027-01-15', '2027-03-15']);
  });
  it('installmentStatus e daysBetween', () => {
    assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30);
    assert.deepEqual(installmentStatus({ dueOn: '2026-05-10', paid: false }, '2026-05-13'), { status: 'overdue', daysOverdue: 3, daysToDue: null });
    assert.deepEqual(installmentStatus({ dueOn: '2026-05-13', paid: false }, '2026-05-13'), { status: 'today', daysOverdue: 0, daysToDue: 0 });
    assert.deepEqual(installmentStatus({ dueOn: '2026-05-20', paid: false }, '2026-05-13'), { status: 'upcoming', daysOverdue: 0, daysToDue: 7 });
    assert.equal(installmentStatus({ dueOn: '2026-05-01', paid: true }, '2026-05-13').status, 'paid');
  });
});

describe('anteprima delle rate: POST /api/payments/generate', () => {
  it('14 rate mensili dal totale, con il resto sull’ultima', async () => {
    const c = await user('a');
    const res = await c.post('/api/payments/generate', { count: 14, firstDue: '2026-11-30', everyMonths: 1, mode: 'total', amount: 3500.1 });
    assert.equal(res.status, 200);
    const list = res.body.installments;
    assert.equal(list.length, 14);
    assert.equal(list[0].dueOn, '2026-11-30');
    assert.equal(list[1].dueOn, '2026-12-30');
    assert.equal(list[3].dueOn, '2027-02-28'); // fine mese rispettata
    assert.equal(Math.round(list.reduce((s, i) => s + i.amount * 100, 0)), 350010);
    assert.ok(list[13].amount >= list[0].amount);
  });
  it('rifiuta totale troppo basso, numero rate fuori limite e date inesistenti', async () => {
    const c = await user('a');
    assert.equal((await c.post('/api/payments/generate', { count: 5, firstDue: '2026-11-01', mode: 'total', amount: 0.03 })).status, 400);
    assert.equal((await c.post('/api/payments/generate', { count: 500, firstDue: '2026-11-01', amount: 10 })).status, 400);
    assert.equal((await c.post('/api/payments/generate', { count: 3, firstDue: '2026-02-31', amount: 10 })).status, 400);
  });
});

describe('creazione e lettura dei piani', () => {
  it('crea il piano con le rate e restituisce numero d’ordine, totale e avanzamento', async () => {
    const c = await user('a');
    const plan = await makePlan(c);
    assert.equal(plan.installments.length, 4);
    assert.deepEqual(plan.installments.map((i) => [i.number, i.total]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
    assert.deepEqual(plan.installments.map((i) => i.status), ['overdue', 'today', 'upcoming', 'upcoming']);
    assert.equal(plan.installments[0].daysOverdue, 3);
    assert.equal(plan.progress.total, 4);
    assert.equal(plan.progress.paidCount, 0);
    assert.equal(plan.progress.percent, 0);
    assert.equal(plan.progress.totalAmount, 100 + 101 + 102 + 103);
    assert.equal(plan.progress.overdueCount, 1);
    assert.equal(plan.progress.next.dueOn, day(-3));
    const list = (await c.get('/api/payments')).body;
    assert.equal(list.plans.length, 1);
    assert.equal(list.today, todayKey());
  });

  it('valida: almeno una rata, categoria dell’utente e di tipo spesa, conto dell’utente, importi positivi', async () => {
    const c = await user('a');
    const other = await user('b');
    const base = { name: 'X', installments: [{ dueOn: day(1), amount: 10 }] };
    assert.equal((await c.post('/api/payments', { ...base, installments: [] })).status, 400);
    assert.equal((await c.post('/api/payments', { ...base, name: '' })).status, 400);
    assert.equal((await c.post('/api/payments', { ...base, installments: [{ dueOn: day(1), amount: 0 }] })).status, 400);
    assert.equal((await c.post('/api/payments', { ...base, installments: [{ dueOn: '2026-13-01', amount: 5 }] })).status, 400);
    const otherCat = await expenseCat(other);
    assert.equal((await c.post('/api/payments', { ...base, categoryId: otherCat.id })).status, 400);
    const { categories } = (await c.get('/api/categories')).body;
    const income = categories.find((x) => x.kind === 'income');
    assert.equal((await c.post('/api/payments', { ...base, categoryId: income.id })).status, 400);
    const { accounts } = (await other.get('/api/accounts')).body;
    assert.equal((await c.post('/api/payments', { ...base, accountId: accounts[0].id })).status, 400);
    assert.equal((await c.post('/api/payments', base)).status, 201);
  });

  it('i piani con qualcosa da pagare vengono prima, i completati in fondo', async () => {
    const c = await user('a');
    const late = await makePlan(c, [20, 30], { name: 'Tardivo' });
    const soon = await makePlan(c, [2, 12], { name: 'Imminente' });
    const done = await makePlan(c, [-9], { name: 'Finito' });
    await c.post(`/api/payments/installments/${done.installments[0].id}/pay`, {});
    const names = (await c.get('/api/payments')).body.plans.map((p) => p.name);
    assert.deepEqual(names, [soon.name, late.name, done.name]);
  });
});

describe('scadenze da segnalare: GET /api/payments/due', () => {
  it('separa scadute/oggi (alert) dalle prossime, con i conteggi e l’ordine per data', async () => {
    const c = await user('a');
    await makePlan(c, [-3, 0, 5, 40]);
    const d = await dueOf(c, 7);
    assert.deepEqual(d.alert.map((i) => i.status), ['overdue', 'today']);
    assert.deepEqual(d.upcoming.map((i) => i.dueOn), [day(5)]);
    assert.deepEqual(d.counts, { alert: 2, overdue: 1, upcoming: 1 });
    assert.equal(d.alert[0].planName, 'Condominio lavori');
    assert.equal(d.alert[0].number, 1);
    assert.equal(d.alert[0].total, 4);
    assert.equal((await dueOf(c, 60)).upcoming.length, 2);
    assert.equal((await dueOf(c, 0)).upcoming.length, 0);
  });

  it('pagare una rata la toglie dall’elenco; eliminare il movimento la rimette', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [-3, 0, 50]);
    const first = plan.installments[0];
    const pay = await c.post(`/api/payments/installments/${first.id}/pay`, {});
    assert.equal(pay.status, 201);
    assert.equal((await dueOf(c)).counts.alert, 1);
    const after = (await c.get('/api/payments')).body.plans[0];
    assert.equal(after.installments[0].paid, true);
    assert.equal(after.installments[0].transactionId, pay.body.transactionId);
    assert.equal(after.progress.paidCount, 1);
    // elimina il movimento: la rata torna da pagare
    assert.equal((await c.del(`/api/transactions/${pay.body.transactionId}`)).status, 200);
    assert.equal((await dueOf(c)).counts.alert, 2);
    assert.equal((await c.get('/api/payments')).body.plans[0].installments[0].paid, false);
  });

  it('ogni utente vede solo le proprie scadenze', async () => {
    const a = await user('a');
    const b = await user('b');
    await makePlan(a, [-1]);
    assert.equal((await dueOf(a)).counts.alert, 1);
    assert.equal((await dueOf(b)).counts.alert, 0);
    assert.equal((await b.get('/api/payments')).body.plans.length, 0);
  });
});

describe('pagamento di una rata: POST /api/payments/installments/:id/pay', () => {
  it('crea una spesa con categoria, conto, ambito e nota del piano e la collega', async () => {
    const c = await user('a');
    const { accounts } = (await c.get('/api/accounts')).body;
    const plan = await makePlan(c, [-2, 20, 40], { accountId: accounts[0].id });
    const inst = plan.installments[1]; // la 2ª
    const res = await c.post(`/api/payments/installments/${inst.id}/pay`, {});
    assert.equal(res.status, 201);
    const tx = (await c.get(`/api/transactions?limit=50`)).body.transactions.find((t) => t.id === res.body.transactionId);
    assert.ok(tx, 'movimento creato');
    assert.equal(tx.type, 'expense');
    assert.equal(tx.amount, inst.amount);
    assert.equal(tx.categoryId, plan.categoryId);
    assert.equal(tx.accountId, accounts[0].id);
    assert.equal(tx.scope, 'home');
    assert.equal(tx.occurredOn, todayKey());
    assert.equal(tx.note, 'Condominio lavori — rata 2/3');
  });

  it('data, importo, conto e nota si possono cambiare; l’avanzamento usa l’importo realmente pagato', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [-2, 20]);
    const { accounts } = (await c.get('/api/accounts')).body;
    const res = await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {
      occurredOn: day(-1), amount: 105.5, accountId: accounts[1].id, note: 'Bollettino pagato in posta',
    });
    assert.equal(res.status, 201);
    const tx = (await c.get('/api/transactions?limit=50')).body.transactions.find((t) => t.id === res.body.transactionId);
    assert.equal(tx.amount, 105.5);
    assert.equal(tx.occurredOn, day(-1));
    assert.equal(tx.accountId, accounts[1].id);
    assert.equal(tx.note, 'Bollettino pagato in posta');
    const p = (await c.get('/api/payments')).body.plans[0];
    assert.equal(p.installments[0].paidAmount, 105.5);
    assert.equal(p.progress.paidAmount, 105.5);
    assert.equal(p.progress.totalAmount, 105.5 + 101);
    assert.equal(p.progress.remainingAmount, 101);
    assert.equal(p.progress.percent, 50);
  });

  it('una rata già pagata dà 409 e non crea un secondo movimento; due richieste insieme ne creano una', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [-2, 20]);
    const id = plan.installments[0].id;
    const [r1, r2] = await Promise.all([c.post(`/api/payments/installments/${id}/pay`, {}), c.post(`/api/payments/installments/${id}/pay`, {})]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    const n = (await h.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`, [c.user.id])).rows[0].n;
    assert.equal(n, 1);
    assert.equal((await c.post(`/api/payments/installments/${id}/pay`, {})).status, 409);
  });

  it('non si può pagare la rata di un altro utente, né usare un suo conto', async () => {
    const a = await user('a');
    const b = await user('b');
    const plan = await makePlan(a, [-2]);
    assert.equal((await b.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {})).status, 404);
    const bAcc = (await b.get('/api/accounts')).body.accounts[0].id;
    assert.equal((await a.post(`/api/payments/installments/${plan.installments[0].id}/pay`, { accountId: bAcc })).status, 400);
    assert.equal((await dueOf(a)).counts.alert, 1);
  });

  it('il piano senza conto lascia il movimento senza conto; accountId null lo toglie esplicitamente', async () => {
    const c = await user('a');
    const { accounts } = (await c.get('/api/accounts')).body;
    const plan = await makePlan(c, [-2, 3], { accountId: accounts[0].id });
    const res = await c.post(`/api/payments/installments/${plan.installments[1].id}/pay`, { accountId: null });
    const tx = (await c.get('/api/transactions?limit=50')).body.transactions.find((t) => t.id === res.body.transactionId);
    assert.equal(tx.accountId, null);
  });
});

describe('modifica di piani e rate', () => {
  it('una rata non pagata si modifica (data e importo) e l’ordine/numero seguono la data', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [10, 20, 30]);
    const last = plan.installments[2];
    const res = await c.patch(`/api/payments/installments/${last.id}`, { dueOn: day(5), amount: 999 });
    assert.equal(res.status, 200);
    const insts = res.body.plan.installments;
    assert.equal(insts[0].id, last.id);
    assert.equal(insts[0].number, 1);
    assert.equal(insts[0].amount, 999);
    assert.equal((await c.patch(`/api/payments/installments/${last.id}`, {})).status, 400);
    assert.equal((await c.patch(`/api/payments/installments/${last.id}`, { amount: -1 })).status, 400);
  });

  it('una rata pagata non si modifica né si elimina (409); quella di un altro utente è 404', async () => {
    const a = await user('a');
    const b = await user('b');
    const plan = await makePlan(a, [-2, 20]);
    const paid = plan.installments[0];
    await a.post(`/api/payments/installments/${paid.id}/pay`, {});
    assert.equal((await a.patch(`/api/payments/installments/${paid.id}`, { amount: 5 })).status, 409);
    assert.equal((await a.del(`/api/payments/installments/${paid.id}`)).status, 409);
    assert.equal((await b.patch(`/api/payments/installments/${plan.installments[1].id}`, { amount: 5 })).status, 404);
    assert.equal((await b.del(`/api/payments/installments/${plan.installments[1].id}`)).status, 404);
  });

  it('elimina una rata non pagata ma non l’ultima rimasta; aggiunge una rata', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [10, 20]);
    const del = await c.del(`/api/payments/installments/${plan.installments[0].id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.plan.installments.length, 1);
    assert.equal(del.body.plan.installments[0].total, 1);
    assert.equal((await c.del(`/api/payments/installments/${del.body.plan.installments[0].id}`)).status, 409);
    const add = await c.post(`/api/payments/${plan.id}/installments`, { dueOn: day(60), amount: 77 });
    assert.equal(add.status, 201);
    assert.equal(add.body.plan.installments.length, 2);
    assert.equal(add.body.plan.installments[1].amount, 77);
    assert.equal((await c.post(`/api/payments/999999/installments`, { dueOn: day(60), amount: 7 })).status, 404);
  });

  it('PATCH del piano: nome, categoria (solo spesa), conto, ambito, nota', async () => {
    const c = await user('a');
    const plan = await makePlan(c);
    const res = await c.patch(`/api/payments/${plan.id}`, { name: 'Lavori facciata', scope: 'personal', note: 'ok', accountId: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.plan.name, 'Lavori facciata');
    assert.equal(res.body.plan.scope, 'personal');
    assert.equal(res.body.plan.note, 'ok');
    const { categories } = (await c.get('/api/categories')).body;
    const income = categories.find((x) => x.kind === 'income');
    assert.equal((await c.patch(`/api/payments/${plan.id}`, { categoryId: income.id })).status, 400);
    assert.equal((await c.patch(`/api/payments/${plan.id}`, {})).status, 400);
    assert.equal((await c.patch(`/api/payments/999999`, { name: 'x' })).status, 404);
  });

  it('eliminare il piano toglie le rate ma lascia i movimenti già registrati', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [-2, 20]);
    const pay = await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {});
    assert.equal((await c.del(`/api/payments/${plan.id}`)).status, 200);
    assert.equal((await c.get('/api/payments')).body.plans.length, 0);
    assert.equal((await dueOf(c)).counts.alert, 0);
    const still = (await c.get('/api/transactions?limit=50')).body.transactions.some((t) => t.id === pay.body.transactionId);
    assert.ok(still);
    assert.equal((await c.del(`/api/payments/${plan.id}`)).status, 404);
  });
});

describe('backup e ripristino personali', () => {
  it('piani, rate e collegamento al movimento si ripristinano con gli id rimappati', async () => {
    const c = await user('a');
    const plan = await makePlan(c, [-5, -1, 30]);
    const pay = await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, { amount: 120 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-pay-'));
    try {
      const dir = await core.createUserBackup({ userId: c.user.id, email: c.user.email, root });
      assert.ok(fs.existsSync(path.join(dir, 'payment_plans.csv')));
      assert.ok(fs.existsSync(path.join(dir, 'payment_installments.csv')));
      // cambia lo stato: elimina il piano e il movimento
      await c.del(`/api/payments/${plan.id}`);
      await c.del(`/api/transactions/${pay.body.transactionId}`);
      await restoreUserBackup({ userId: c.user.id, dir });
      const back = (await c.get('/api/payments')).body.plans;
      assert.equal(back.length, 1);
      assert.equal(back[0].name, 'Condominio lavori');
      assert.equal(back[0].installments.length, 3);
      assert.equal(back[0].installments[0].paid, true);
      assert.equal(back[0].installments[0].paidAmount, 120);
      assert.equal(back[0].installments[1].paid, false);
      assert.equal(back[0].progress.paidCount, 1);
      assert.notEqual(back[0].installments[0].transactionId, pay.body.transactionId, 'id rigenerato');
      // dopo il ripristino si può pagare la rata successiva
      assert.equal((await c.post(`/api/payments/installments/${back[0].installments[1].id}/pay`, {})).status, 201);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('un backup vecchio, senza i file dei pagamenti, si ripristina e lascia l’utente senza piani', async () => {
    const c = await user('a');
    await makePlan(c, [3]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-pay-'));
    try {
      const dir = await core.createUserBackup({ userId: c.user.id, email: c.user.email, root });
      fs.rmSync(path.join(dir, 'payment_plans.csv'));
      fs.rmSync(path.join(dir, 'payment_installments.csv'));
      await restoreUserBackup({ userId: c.user.id, dir });
      assert.equal((await c.get('/api/payments')).body.plans.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

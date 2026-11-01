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
// Due utenti bastano (i test a due voci usano etichette consecutive): si sceglie dalla parità dell'ultimo carattere.
async function user(tag) {
  const slot = tag.charCodeAt(tag.length - 1) % 2;
  users[slot] ||= await h.registerUser(server.base, `pay-${slot}`);
  const id = users[slot].user.id;
  await h.query('DELETE FROM payment_plans WHERE user_id = $1', [id]);
  await h.query('DELETE FROM transactions WHERE user_id = $1', [id]);
  return users[slot];
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
    assert.equal(tx.note, 'Condominio lavori 2 di 3');
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

const planOf = async (c) => (await c.get('/api/payments')).body.plans[0];

describe('modifica del piano con tutte le rate: PATCH /api/payments/:id { installments }', () => {
  const rows = (plan) => plan.installments.map((i) => ({ id: i.id, dueOn: i.dueOn, amount: i.amount }));

  it('14 rate da 124,71: cambiare la rata 10 ricalcola il totale e le altre restano', async () => {
    const c = await user('m1');
    const gen = (await c.post('/api/payments/generate', { count: 14, firstDue: day(5), mode: 'each', amount: 124.71 })).body.installments;
    const plan = (await c.post('/api/payments', { name: 'Condominio', installments: gen })).body.plan;
    assert.equal(plan.progress.totalAmount, 1745.94);
    const list = rows(plan);
    list[9].amount = 200;
    const res = await c.patch(`/api/payments/${plan.id}`, { installments: list });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.plan;
    assert.equal(p.installments.length, 14);
    assert.equal(p.installments[9].amount, 200);
    assert.equal(p.installments.filter((i) => i.amount === 124.71).length, 13);
    assert.equal(p.progress.totalAmount, 1745.94 - 124.71 + 200);
    assert.deepEqual(p.installments.map((i) => i.id), plan.installments.map((i) => i.id), 'stesse rate, nessuna ricreata');
  });

  it('aggiunge rate (senza id), elimina quelle non nominate, aggiorna date e campi del piano insieme', async () => {
    const c = await user('m2');
    const plan = await makePlan(c, [5, 15, 25]);
    const [a, , cc] = plan.installments;
    const res = await c.patch(`/api/payments/${plan.id}`, {
      name: 'Rinominato',
      installments: [
        { id: a.id, dueOn: day(7), amount: 10 },
        { id: cc.id, dueOn: day(27), amount: 30 },
        { dueOn: day(60), amount: 40 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.plan.name, 'Rinominato');
    assert.deepEqual(res.body.plan.installments.map((i) => [i.dueOn, i.amount]), [[day(7), 10], [day(27), 30], [day(60), 40]]);
    assert.equal(res.body.plan.installments[0].id, a.id);
    assert.ok(!res.body.plan.installments.some((i) => i.id === plan.installments[1].id), 'la rata non nominata è stata eliminata');
  });

  it('le rate pagate restano; non si possono modificare da qui (409) e il piano non cambia', async () => {
    const c = await user('m3');
    const plan = await makePlan(c, [-3, 10, 20]);
    const pay = await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, { amount: 111 });
    // lista solo delle non pagate: la pagata resta
    const ok = await c.patch(`/api/payments/${plan.id}`, { installments: [{ id: plan.installments[1].id, dueOn: day(11), amount: 50 }] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.plan.installments.map((i) => i.paid), [true, false]);
    assert.equal(ok.body.plan.installments[0].transactionId, pay.body.transactionId);
    const bad = await c.patch(`/api/payments/${plan.id}`, { installments: [{ id: plan.installments[0].id, dueOn: day(1), amount: 5 }] });
    assert.equal(bad.status, 409);
    assert.equal((await planOf(c)).installments[0].paidAmount, 111);
  });

  it('errori: rata di un altro piano/utente, id ripetuto, nessuna rata, troppe rate; tutto o niente', async () => {
    const a = await user('m4');
    const b = await user('m5');
    const plan = await makePlan(a, [5, 15]);
    const other = await makePlan(b, [5]);
    const [i1] = plan.installments;
    const before = rows(plan);
    const send = (installments, extra = {}) => a.patch(`/api/payments/${plan.id}`, { installments, ...extra });
    assert.equal((await send([{ id: other.installments[0].id, dueOn: day(1), amount: 5 }], { name: 'Hack' })).status, 400);
    assert.equal((await send([{ id: i1.id, dueOn: day(1), amount: 5 }, { id: i1.id, dueOn: day(2), amount: 6 }])).status, 400);
    assert.equal((await send([])).status, 400, 'senza rate pagate il piano non può restare vuoto');
    assert.equal((await send([{ dueOn: day(1), amount: 0 }])).status, 400);
    assert.equal((await send(Array.from({ length: 121 }, (_, k) => ({ dueOn: day(k), amount: 1 })))).status, 400);
    const after = await planOf(a);
    assert.equal(after.name, 'Condominio lavori', 'nessuna modifica parziale');
    assert.deepEqual(rows(after), before);
    assert.equal((await planOf(b)).installments[0].amount, 100, 'il piano altrui è intatto');
  });

  it('un piano tutto pagato accetta un elenco vuoto (nessuna rata da modificare)', async () => {
    const c = await user('m6');
    const plan = await makePlan(c, [-1]);
    await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {});
    const res = await c.patch(`/api/payments/${plan.id}`, { name: 'Chiuso', installments: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body.plan.installments.length, 1);
  });
});

describe('rate uguali: POST /api/payments/:id/equalize', () => {
  it('«ogni rata» imposta lo stesso importo alle sole rate non pagate', async () => {
    const c = await user('e1');
    const plan = await makePlan(c, [-4, 5, 20, 40]);
    await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {});
    const res = await c.post(`/api/payments/${plan.id}/equalize`, { mode: 'each', amount: 250 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const i = res.body.plan.installments;
    assert.equal(i[0].paidAmount, 100, 'la rata pagata non cambia');
    assert.deepEqual(i.slice(1).map((x) => x.amount), [250, 250, 250]);
    assert.equal(res.body.plan.progress.totalAmount, 100 + 750);
  });

  it('«totale» divide tra le rate da pagare con il resto dei centesimi sull’ultima', async () => {
    const c = await user('e2');
    const plan = await makePlan(c, [-4, 5, 20]);
    await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {});
    const res = await c.post(`/api/payments/${plan.id}/equalize`, { mode: 'total', amount: 100.01 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plan.installments.slice(1).map((x) => x.amount), [50, 50.01]);
    const all = await c.post(`/api/payments/${plan.id}/equalize`, { mode: 'total', amount: 1000 });
    assert.deepEqual(all.body.plan.installments.slice(1).map((x) => x.amount), [500, 500]);
  });

  it('errori: importo troppo basso, piano senza rate da pagare, piano altrui o inesistente, importo non valido', async () => {
    const a = await user('e3');
    const b = await user('e4');
    const plan = await makePlan(a, [-2, 10]);
    assert.equal((await a.post(`/api/payments/${plan.id}/equalize`, { mode: 'total', amount: 0.01 })).status, 400);
    assert.equal((await a.post(`/api/payments/${plan.id}/equalize`, { mode: 'each', amount: 0 })).status, 400);
    assert.equal((await a.post(`/api/payments/${plan.id}/equalize`, { mode: 'boh', amount: 5 })).status, 400);
    assert.equal((await b.post(`/api/payments/${plan.id}/equalize`, { mode: 'each', amount: 5 })).status, 404);
    assert.equal((await a.post(`/api/payments/999999/equalize`, { mode: 'each', amount: 5 })).status, 404);
    assert.deepEqual((await planOf(a)).installments.map((x) => x.amount), [100, 101], 'nulla è cambiato');
    for (const i of plan.installments) await a.post(`/api/payments/installments/${i.id}/pay`, {});
    assert.equal((await a.post(`/api/payments/${plan.id}/equalize`, { mode: 'each', amount: 5 })).status, 409);
  });
});

describe('movimenti collegati ai piani', () => {
  const txBody = (over = {}) => ({ type: 'expense', amount: 55, scope: 'home', note: 'Bonifico', ...over });
  const txOf = async (c, id) => (await c.get('/api/transactions?limit=200')).body.transactions.find((t) => t.id === id);
  
  it('registrare un movimento con installmentId salda la rata e il movimento mostra piano e numero', async () => {
    const c = await user('l1');
    const plan = await makePlan(c, [-4, 10, 40]);
    const inst = plan.installments[1];
    const res = await c.post('/api/transactions', txBody({ amount: 101, note: 'Condominio lavori 2 di 3', installmentId: inst.id }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = res.body.transaction;
    assert.equal(t.paymentInstallmentId, inst.id);
    assert.equal(t.paymentPlanId, plan.id);
    assert.equal(t.paymentPlanName, 'Condominio lavori');
    assert.deepEqual([t.paymentNumber, t.paymentTotal], [2, 3]);
    const p = await planOf(c);
    assert.equal(p.installments[1].paid, true);
    assert.equal(p.installments[1].transactionId, t.id);
    assert.equal(p.progress.paidCount, 1);
    assert.equal((await dueOf(c)).counts.alert, 1); // resta solo la prima, scaduta
  });

  it('un movimento senza collegamento non ha i campi del piano; solo una spesa può saldare una rata', async () => {
    const c = await user('l2');
    const plan = await makePlan(c, [3]);
    const plain = (await c.post('/api/transactions', txBody())).body.transaction;
    assert.equal(plain.paymentInstallmentId, null);
    assert.equal(plain.paymentPlanName, null);
    const income = await c.post('/api/transactions', txBody({ type: 'income', installmentId: plan.installments[0].id }));
    assert.equal(income.status, 400);
    assert.equal((await dueOf(c, 30)).counts.upcoming, 1, 'nessun movimento creato a metà');
    assert.equal((await h.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [c.user.id])).rows[0].n, 1);
  });

  it('rata già saldata → 409 senza creare il movimento; rata di un altro utente o inesistente → 400', async () => {
    const a = await user('l3');
    const b = await user('l4');
    const plan = await makePlan(a, [-1, 20]);
    const first = plan.installments[0].id;
    assert.equal((await a.post('/api/transactions', txBody({ installmentId: first }))).status, 201);
    assert.equal((await a.post('/api/transactions', txBody({ installmentId: first }))).status, 409);
    assert.equal((await b.post('/api/transactions', txBody({ installmentId: plan.installments[1].id }))).status, 400);
    assert.equal((await a.post('/api/transactions', txBody({ installmentId: 999999 }))).status, 400);
    assert.equal((await h.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [a.user.id])).rows[0].n, 1);
    assert.equal((await h.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [b.user.id])).rows[0].n, 0);
  });

  it('modificare importo e data di un pagamento già registrato aggiorna il piano', async () => {
    const c = await user('l5');
    const plan = await makePlan(c, [-4, 10]);
    const pay = await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {});
    const before = await planOf(c);
    assert.equal(before.progress.paidAmount, 100);
    const edit = await c.patch(`/api/transactions/${pay.body.transactionId}`, { amount: 130.25, occurredOn: day(-2) });
    assert.equal(edit.status, 200);
    const after = await planOf(c);
    assert.equal(after.installments[0].paidAmount, 130.25);
    assert.equal(after.installments[0].paidOn, day(-2));
    assert.equal(after.progress.paidAmount, 130.25);
    assert.equal(after.progress.totalAmount, 130.25 + 101);
    assert.equal(after.progress.remainingAmount, 101);
    assert.equal(after.installments[0].transactionId, pay.body.transactionId);
  });

  it('scollegare (installmentId null) lascia il movimento ma la rata torna da pagare; ricollegare la sposta', async () => {
    const c = await user('l6');
    const plan = await makePlan(c, [-4, -2, 30]);
    const [i1, i2] = plan.installments;
    const pay = await c.post(`/api/payments/installments/${i1.id}/pay`, {});
    const txId = pay.body.transactionId;
    const un = await c.patch(`/api/transactions/${txId}`, { installmentId: null });
    assert.equal(un.status, 200);
    assert.equal(un.body.transaction.paymentInstallmentId, null);
    assert.ok(await txOf(c, txId), 'il movimento resta');
    assert.equal((await planOf(c)).installments[0].paid, false);
    // lo collego alla seconda rata
    const re = await c.patch(`/api/transactions/${txId}`, { installmentId: i2.id });
    assert.equal(re.status, 200);
    assert.deepEqual([re.body.transaction.paymentNumber, re.body.transaction.paymentTotal], [2, 3]);
    let p = await planOf(c);
    assert.deepEqual(p.installments.map((i) => i.paid), [false, true, false]);
    // spostarlo sulla prima libera la seconda
    await c.patch(`/api/transactions/${txId}`, { installmentId: i1.id });
    p = await planOf(c);
    assert.deepEqual(p.installments.map((i) => i.paid), [true, false, false]);
    // un movimento qualsiasi si può collegare a una rata libera
    const loose = (await c.post('/api/transactions', txBody({ amount: 99 }))).body.transaction;
    assert.equal((await c.patch(`/api/transactions/${loose.id}`, { installmentId: i2.id })).status, 200);
    assert.equal((await planOf(c)).progress.paidCount, 2);
    // …ma non a una già saldata da un altro movimento
    assert.equal((await c.patch(`/api/transactions/${loose.id}`, { installmentId: i1.id })).status, 409);
    assert.equal((await planOf(c)).installments[1].transactionId, loose.id, 'la rata resta com’era dopo l’errore');
  });

  it('un movimento collegato non può diventare un’entrata (400, nulla cambia); scollegato sì', async () => {
    const c = await user('l7');
    const plan = await makePlan(c, [-1]);
    const pay = await c.post(`/api/payments/installments/${plan.installments[0].id}/pay`, {});
    const txId = pay.body.transactionId;
    assert.equal((await c.patch(`/api/transactions/${txId}`, { type: 'income', categoryId: null })).status, 400);
    assert.equal((await txOf(c, txId)).type, 'expense');
    const both = await c.patch(`/api/transactions/${txId}`, { type: 'income', categoryId: null, installmentId: null });
    assert.equal(both.status, 200);
    assert.equal(both.body.transaction.type, 'income');
    assert.equal((await planOf(c)).installments[0].paid, false);
  });

  it('GET /api/transactions?paymentPlanId= elenca solo i movimenti del piano; un piano altrui non restituisce nulla', async () => {
    const a = await user('l8');
    const b = await user('l9');
    const planA = await makePlan(a, [-3, -2, 20], { name: 'Piano A' });
    const planA2 = await makePlan(a, [-1], { name: 'Altro piano' });
    await a.post(`/api/payments/installments/${planA.installments[0].id}/pay`, {});
    await a.post(`/api/payments/installments/${planA.installments[1].id}/pay`, {});
    await a.post(`/api/payments/installments/${planA2.installments[0].id}/pay`, {});
    await a.post('/api/transactions', txBody());
    const list = (await a.get(`/api/transactions?paymentPlanId=${planA.id}&limit=50`)).body.transactions;
    assert.equal(list.length, 2);
    assert.ok(list.every((t) => t.paymentPlanId === planA.id));
    assert.deepEqual(list.map((t) => t.paymentNumber).sort(), [1, 2]);
    assert.equal((await b.get(`/api/transactions?paymentPlanId=${planA.id}&limit=50`)).body.transactions.length, 0);
    assert.equal((await a.get('/api/transactions?limit=50')).body.transactions.length, 4);
  });

  it('le rate scollegate dal piano (rata eliminata dopo il pagamento non è permesso) restano coerenti con il numero d’ordine', async () => {
    const c = await user('l10');
    const plan = await makePlan(c, [-5, -3, 20]);
    const pay = await c.post(`/api/payments/installments/${plan.installments[1].id}/pay`, {});
    // elimino la prima (non pagata): il pagamento passa da 2/3 a 1/2
    assert.equal((await c.del(`/api/payments/installments/${plan.installments[0].id}`)).status, 200);
    const t = await txOf(c, pay.body.transactionId);
    assert.deepEqual([t.paymentNumber, t.paymentTotal], [1, 2]);
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

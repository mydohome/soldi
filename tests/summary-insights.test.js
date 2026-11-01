'use strict';

// GET /api/summary/overview → insights: media al giorno con e senza spese fisse, peso delle spese
// fisse, picchi (solo spese non fisse), proiezione e confronto col mese precedente.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { todayKey } = require('../src/payments/schedule');

let server;
let c;
let other;
let cat;
before(async () => {
  await h.prepareDatabase();
  server = await h.startServer();
  c = await h.registerUser(server.base, 'ins-a');
  other = await h.registerUser(server.base, 'ins-b');
  cat = (await c.get('/api/categories')).body.categories.find((x) => x.kind === 'expense');
});
after(async () => {
  await server.stop();
  await h.closePool();
});

let ruleSeq = 0;
async function rule(userId, name) {
  ruleSeq += 1;
  return Number((await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, start_month) VALUES ($1,$2,100,'2020-01-01') RETURNING id`, [userId, `${name}-${ruleSeq}`])).rows[0].id);
}
async function tx(userId, { type = 'expense', cents, on, note = '', scope = 'personal', ruleId = null, categoryId = null }) {
  await h.query(
    `INSERT INTO transactions (user_id, type, amount_cents, category_id, recurring_rule_id, scope, note, occurred_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, type, cents, categoryId, ruleId, scope, note, on]
  );
}
const insights = async (client, anchor, scope) =>
  (await client.get(`/api/summary/overview?anchor=${anchor}${scope ? `&scope=${scope}` : ''}`)).body.insights;

describe('indicatori del mese (febbraio 2025, 28 giorni; gennaio 31)', () => {
  before(async () => {
    const id = c.user.id;
    const rentFeb = await rule(id, 'affitto');
    const netFeb = await rule(id, 'internet');
    await tx(id, { cents: 40000, on: '2025-02-01', ruleId: rentFeb });
    await tx(id, { cents: 2000, on: '2025-02-05', ruleId: netFeb });
    await tx(id, { cents: 10000, on: '2025-02-03', note: 'Cena', categoryId: cat.id });
    await tx(id, { cents: 25050, on: '2025-02-10', note: 'Elettrodomestico', categoryId: cat.id });
    await tx(id, { cents: 4950, on: '2025-02-10', note: 'Casa', scope: 'home' });
    await tx(id, { type: 'income', cents: 100000, on: '2025-02-01' });
    const rentJan = await rule(id, 'affitto-gen');
    await tx(id, { cents: 40000, on: '2025-01-01', ruleId: rentJan });
    await tx(id, { cents: 6200, on: '2025-01-05' });
  });

  it('totali, quota delle spese fisse e medie con e senza fisse', async () => {
    const i = await insights(c, '2025-02-15');
    assert.equal(i.month, '2025-02');
    assert.equal(i.daysInMonth, 28);
    assert.equal(i.daysElapsed, 28);
    assert.equal(i.isCurrent, false);
    assert.equal(i.expense, 820);
    assert.equal(i.fixed, 420);
    assert.equal(i.variable, 400);
    assert.equal(i.fixedShare, 51);
    assert.equal(i.avgPerDay, 29.29);
    assert.equal(i.avgPerDayVariable, 14.29);
    assert.equal(i.projection, null, 'nessuna stima per un mese passato');
  });

  it('i picchi ignorano le spese fisse e le entrate', async () => {
    const i = await insights(c, '2025-02-15');
    assert.deepEqual(i.peak, { amount: 250.5, date: '2025-02-10', note: 'Elettrodomestico', category: cat.name });
    assert.deepEqual(i.peakDay, { date: '2025-02-10', amount: 300 });
  });

  it('confronto col mese precedente (31 giorni)', async () => {
    const p = (await insights(c, '2025-02-15')).prev;
    assert.equal(p.month, '2025-01');
    assert.equal(p.expense, 462);
    assert.equal(p.fixed, 400);
    assert.equal(p.variable, 62);
    assert.equal(p.fixedShare, 87);
    assert.equal(p.avgPerDay, 14.9);
    assert.equal(p.avgPerDayVariable, 2);
  });

  it('il filtro di ambito vale anche per gli indicatori', async () => {
    const home = await insights(c, '2025-02-15', 'home');
    assert.equal(home.expense, 49.5);
    assert.equal(home.fixed, 0);
    assert.equal(home.fixedShare, 0);
    assert.deepEqual(home.peak, { amount: 49.5, date: '2025-02-10', note: 'Casa', category: null });
    const personal = await insights(c, '2025-02-15', 'personal');
    assert.equal(personal.expense, 770.5);
    assert.equal(personal.variable, 350.5);
  });

  it('mese senza movimenti: zeri, nessun picco, nessuna quota; mese futuro: nessuna media', async () => {
    const empty = await insights(c, '2025-06-15');
    assert.equal(empty.expense, 0);
    assert.equal(empty.fixedShare, null);
    assert.equal(empty.peak, null);
    assert.equal(empty.peakDay, null);
    assert.equal(empty.avgPerDay, 0);
    const future = await insights(c, '2099-01-10');
    assert.equal(future.daysElapsed, 0);
    assert.equal(future.avgPerDay, null);
    assert.equal(future.avgPerDayVariable, null);
    assert.equal(future.projection, null);
  });

  it('un altro utente non vede nulla di questi dati', async () => {
    const i = await insights(other, '2025-02-15');
    assert.equal(i.expense, 0);
    assert.equal(i.peak, null);
    assert.equal(i.prev.expense, 0);
  });
});

describe('mese in corso: giorni trascorsi e proiezione', () => {
  it('la media usa i giorni trascorsi; la proiezione compare dal 5° giorno', async () => {
    const id = other.user.id;
    const today = todayKey();
    const r = await rule(id, 'fissa-corrente');
    await tx(id, { cents: 10000, on: today, ruleId: r });
    await tx(id, { cents: 3000, on: today, note: 'Oggi' });
    const i = await insights(other, today);
    const elapsed = Number(today.slice(8, 10));
    assert.equal(i.isCurrent, true);
    assert.equal(i.daysElapsed, elapsed);
    assert.equal(i.expense, 130);
    assert.equal(i.avgPerDay, Math.round((13000 / elapsed)) / 100);
    assert.equal(i.avgPerDayVariable, Math.round((3000 / elapsed)) / 100);
    if (elapsed >= 5) assert.equal(i.projection, (10000 + Math.round((3000 / elapsed) * i.daysInMonth)) / 100);
    else assert.equal(i.projection, null);
  });
});

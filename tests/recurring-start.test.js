'use strict';

// Spese fisse — data di inizio modificabile: i movimenti già generati si spostano e la data finale slitta.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const S = require('../src/recurring/schedule');

let server;
before(async () => {
  await h.prepareDatabase();
  server = await h.startServer();
});
after(async () => {
  await server.stop();
  await h.closePool();
});

// chiave YYYY-MM-01 del mese corrente + offset (UTC, come il server)
const mk = (offset) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
};
const ym = (offset) => mk(offset).slice(0, 7);
const months = async (ruleId) =>
  (await h.query(`SELECT to_char(occurred_on, 'YYYY-MM') AS m FROM transactions WHERE recurring_rule_id = $1 ORDER BY occurred_on`, [ruleId])).rows.map((r) => r.m);
const rule = async (c, id) => (await c.get('/api/recurring')).body.rules.find((r) => r.id === id);

const create = (c, over = {}) =>
  c.post('/api/recurring', { name: 'Finanziamento', amount: 100, dayOfMonth: 1, ...over });

describe('calendario con rate saltate (funzioni pure)', () => {
  const base = { cadence: 'monthly', month: null, total_occurrences: 3, start_month: '2026-01-01', last_run_month: '2026-03-01', skipped_months: '' };
  it('senza rate saltate: invariato', () => {
    assert.deepEqual(S.scheduleSlots(base), ['2026-01-01', '2026-02-01', '2026-03-01']);
    assert.equal(S.scheduleEndMonth(base), '2026-03-01');
    assert.equal(S.installmentsDone(base), 3);
  });
  it('una rata saltata sposta la fine in avanti e riduce le rate pagate', () => {
    const r = { ...base, skipped_months: '2026-02' };
    assert.deepEqual(S.scheduleSlots(r), ['2026-01-01', '2026-03-01', '2026-04-01']);
    assert.equal(S.scheduleEndMonth(r), '2026-04-01');
    assert.equal(S.installmentsDone(r), 2); // gennaio e marzo
    assert.equal(S.slotMonthForDate(r, '2026-02-10'), null, 'il mese saltato non è più uno slot');
    assert.equal(S.slotMonthForDate(r, '2026-04-10'), '2026-04-01');
    assert.equal(S.slotMonthForDate(r, '2026-05-10'), null, 'oltre l’ultima rata');
  });
  it('annuale: salta un anno e la fine slitta di un anno', () => {
    const y = { cadence: 'yearly', month: 3, total_occurrences: 3, start_month: '2026-01-01', last_run_month: '2027-12-01', skipped_months: '2027-03' };
    assert.deepEqual(S.scheduleSlots(y), ['2026-03-01', '2028-03-01', '2029-03-01']);
    assert.equal(S.installmentsDone(y), 1);
  });
  it('recurringHits e dueSlots rispettano le rate saltate', () => {
    const r = { ...base, skipped_months: '2026-02' };
    assert.deepEqual(S.recurringHits(r, 2026).slice(0, 5).map(Number), [1, 0, 1, 1, 0]);
    const open = { ...base, total_occurrences: null, skipped_months: '2026-02' };
    assert.deepEqual(S.recurringHits(open, 2026).slice(0, 4).map(Number), [1, 0, 1, 1]);
    assert.deepEqual(S.dueSlots({ ...base, last_run_month: '2026-01-01', skipped_months: '2026-02' }, '2026-01-01', '2026-06-01'), ['2026-03-01', '2026-04-01']);
  });
  it('skippedSet accetta stringhe e array e ignora i valori non validi', () => {
    assert.deepEqual([...S.skippedSet('2026-03, 2026-05,boh,')].sort(), ['2026-03', '2026-05']);
    assert.deepEqual([...S.skippedSet(['2026-03-01'])], ['2026-03']);
    assert.equal(S.skippedToString(new Set(['2026-05', '2026-03'])), '2026-03,2026-05');
  });
});

describe('creazione con data di inizio', () => {
  it('inizio nel passato: i movimenti arretrati si creano subito, a partire dall’inizio', async () => {
    const c = await h.registerUser(server.base, 'st1');
    const res = await create(c, { totalOccurrences: 12, startMonth: ym(-4) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.generated, 5);
    assert.equal(res.body.rule.startMonth, mk(-4));
    assert.deepEqual(await months(res.body.rule.id), [-4, -3, -2, -1, 0].map(ym));
    const p = res.body.rule.progress;
    assert.equal(p.done, 5);
    assert.equal(p.endMonth, ym(-4 + 11));
  });
  it('senza startMonth l’inizio è il mese corrente (come prima); formato AAAA-MM-GG accettato', async () => {
    const c = await h.registerUser(server.base, 'st2');
    const a = await create(c);
    assert.equal(a.body.rule.startMonth, mk(0));
    const b = await create(c, { name: 'Altra', startMonth: `${ym(-1)}-17` });
    assert.equal(b.body.rule.startMonth, mk(-1), 'conta il mese');
  });
  it('data non valida → 400', async () => {
    const c = await h.registerUser(server.base, 'st3');
    for (const bad of ['2026-13', '26-01', 'marzo', '2026-00']) {
      assert.equal((await create(c, { startMonth: bad })).status, 400, bad);
    }
  });
});

describe('modifica della data di inizio', () => {
  async function seeded(c, over = {}) {
    // 5 movimenti (da -4 a 0), a rate limitate, creata con inizio nel passato
    const res = await create(c, { totalOccurrences: 12, startMonth: ym(-4), ...over });
    return res.body.rule;
  }

  it('inizio spostato in avanti di 2 mesi: movimenti e data finale slittano di 2 mesi', async () => {
    const c = await h.registerUser(server.base, 'sm1');
    const r = await seeded(c);
    const prev = await c.get(`/api/recurring/${r.id}/start-preview?startMonth=${ym(-2)}`);
    assert.equal(prev.status, 200);
    assert.deepEqual(
      [prev.body.changed, prev.body.shifted, prev.body.months, prev.body.movements, prev.body.futureMovements, prev.body.endBefore, prev.body.endAfter],
      [true, true, 2, 5, 2, ym(7), ym(9)]
    );
    const res = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-2) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.shifted, { applied: true, movements: 5, months: 2 });
    assert.deepEqual(await months(r.id), [-2, -1, 0, 1, 2].map(ym));
    assert.equal(res.body.rule.startMonth, mk(-2));
    assert.equal(res.body.rule.lastRunMonth, mk(2));
    assert.equal(res.body.rule.progress.endMonth, ym(9));
  });

  it('inizio spostato indietro di 2 mesi: i movimenti scalano e i mesi arretrati vengono creati', async () => {
    const c = await h.registerUser(server.base, 'sm2');
    const r = await seeded(c);
    const prev = await c.get(`/api/recurring/${r.id}/start-preview?startMonth=${ym(-6)}`);
    assert.equal(prev.body.months, -2);
    assert.equal(prev.body.backfill, 2, 'i due mesi tra il cursore spostato e oggi');
    const res = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-6) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.generated, 2);
    assert.deepEqual(await months(r.id), [-6, -5, -4, -3, -2, -1, 0].map(ym), 'serie continua, nessun doppione');
    assert.equal(res.body.rule.progress.endMonth, ym(5));
    assert.equal(res.body.rule.progress.done, 7);
  });

  it('senza limite di rate: si spostano i movimenti, nessuna data finale', async () => {
    const c = await h.registerUser(server.base, 'sm3');
    const r = await seeded(c, { totalOccurrences: null });
    const res = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-3) });
    assert.deepEqual(res.body.shifted, { applied: true, movements: 5, months: 1 });
    assert.equal(res.body.rule.progress, null);
  });

  it('annuale: lo spostamento è di anni interi, e nello stesso anno non cambia nulla', async () => {
    const c = await h.registerUser(server.base, 'sm4');
    const month = new Date().getUTCMonth() + 1;
    const startYear = new Date().getUTCFullYear() - 2;
    const res = await create(c, { cadence: 'yearly', month, totalOccurrences: 5, startMonth: `${startYear}-01` });
    const r = res.body.rule;
    const before = await months(r.id);
    assert.equal(before.length, 3, JSON.stringify(before));
    // stesso primo anno (gennaio → febbraio, prima del mese di scatto, salvo il mese corrente = gennaio)
    const same = await c.patch(`/api/recurring/${r.id}`, { startMonth: `${startYear}-01` });
    assert.equal(same.body.shifted.applied, false);
    const prev = await c.get(`/api/recurring/${r.id}/start-preview?startMonth=${startYear + 1}-01`);
    assert.equal(prev.body.months % 12, 0);
    const moved = await c.patch(`/api/recurring/${r.id}`, { startMonth: `${startYear + 1}-01` });
    assert.equal(moved.body.shifted.months, 12);
    const after = await months(r.id);
    assert.deepEqual(after.map((m) => Number(m.slice(0, 4))), before.map((m) => Number(m.slice(0, 4)) + 1).slice(0, after.length));
  });

  it('se nello stesso salvataggio cambia la cadenza i movimenti esistenti non si spostano', async () => {
    const c = await h.registerUser(server.base, 'sm5');
    const r = await seeded(c);
    const before = await months(r.id);
    const res = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-2), cadence: 'yearly', month: 6 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.shifted.applied, false);
    assert.deepEqual((await months(r.id)).slice(0, before.length), before);
  });

  it('anteprima con cadenza cambiata: i movimenti non si spostano', async () => {
    const c = await h.registerUser(server.base, 'sm5b');
    const r = await seeded(c);
    const prev = await c.get(`/api/recurring/${r.id}/start-preview?startMonth=${ym(-2)}&cadence=yearly&month=6`);
    assert.equal(prev.status, 200);
    assert.deepEqual([prev.body.shifted, prev.body.months, prev.body.futureMovements], [false, 0, 0]);
  });

  it('stessa data o nessuno startMonth: nessuno spostamento; regola in pausa: nessun arretrato', async () => {
    const c = await h.registerUser(server.base, 'sm6');
    const r = await seeded(c);
    assert.equal((await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-4) })).body.shifted.applied, false);
    assert.equal((await c.patch(`/api/recurring/${r.id}`, { name: 'Rinominata' })).body.shifted.applied, false);
    await c.patch(`/api/recurring/${r.id}`, { active: false });
    const prev = await c.get(`/api/recurring/${r.id}/start-preview?startMonth=${ym(-6)}`);
    assert.equal(prev.body.backfill, 0, 'una regola disattivata non genera arretrati');
  });

  it('isolamento: anteprima e modifica della regola di un altro utente → 404', async () => {
    const a = await h.registerUser(server.base, 'sm7a');
    const b = await h.registerUser(server.base, 'sm7b');
    const r = await seeded(a);
    assert.equal((await b.get(`/api/recurring/${r.id}/start-preview?startMonth=${ym(-1)}`)).status, 404);
    assert.equal((await b.patch(`/api/recurring/${r.id}`, { startMonth: ym(-1) })).status, 404);
    assert.deepEqual(await months(r.id), [-4, -3, -2, -1, 0].map(ym), 'i dati di A sono intatti');
    assert.equal((await h.registerUser(server.base, 'sm7c')).get === undefined, false);
  });

  it('anteprima: parametri non validi → 400; senza sessione → 401', async () => {
    const c = await h.registerUser(server.base, 'sm8');
    const r = await seeded(c);
    assert.equal((await c.get(`/api/recurring/${r.id}/start-preview?startMonth=boh`)).status, 400);
    assert.equal((await c.get(`/api/recurring/${r.id}/start-preview`)).status, 400);
    const anon = new h.Client(server.base, null, null);
    assert.equal((await anon.get(`/api/recurring/${r.id}/start-preview?startMonth=${ym(-1)}`)).status, 401);
  });

  it('i movimenti spostati restano nello stesso giorno del mese e l’indice univoco non si rompe con molte rate', async () => {
    const c = await h.registerUser(server.base, 'sm9');
    const res = await create(c, { dayOfMonth: 15, startMonth: ym(-11) });
    const r = res.body.rule;
    // il mese corrente è dovuto solo dal giorno 15 in poi
    const n0 = new Date().getUTCDate() >= 15 ? 12 : 11;
    assert.equal((await months(r.id)).length, n0);
    const shifted = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-10) });
    assert.equal(shifted.status, 200, JSON.stringify(shifted.body));
    const days = (await h.query(`SELECT DISTINCT to_char(occurred_on, 'DD') d FROM transactions WHERE recurring_rule_id = $1`, [r.id])).rows;
    assert.deepEqual(days, [{ d: '15' }]);
    const back = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-11) });
    assert.equal(back.status, 200);
    assert.equal((await months(r.id)).length, n0);
    assert.equal((await rule(c, r.id)).startMonth, mk(-11));
  });
});

'use strict';

// Eliminare il movimento di una rata di una spesa fissa: «aggiornare lo stato delle rate» (rata saltata,
// data finale che slitta) oppure eliminare soltanto il movimento.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');

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

const mk = (offset) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
};
const ym = (offset) => mk(offset).slice(0, 7);
const months = async (ruleId) =>
  (await h.query(`SELECT to_char(occurred_on, 'YYYY-MM') AS m FROM transactions WHERE recurring_rule_id = $1 ORDER BY occurred_on`, [ruleId])).rows.map((r) => r.m);
const txAt = async (ruleId, offset) =>
  Number((await h.query(`SELECT id FROM transactions WHERE recurring_rule_id = $1 AND to_char(occurred_on, 'YYYY-MM') = $2`, [ruleId, ym(offset)])).rows[0].id);
const rule = async (c, id) => (await c.get('/api/recurring')).body.rules.find((r) => r.id === id);
const run = (c) => c.post('/api/recurring/run');

// Regola a 12 rate con inizio 4 mesi fa: cinque movimenti generati (da -4 a 0).
async function limitedRule(c, over = {}) {
  const res = await c.post('/api/recurring', { name: 'Finanziamento', amount: 100, dayOfMonth: 1, totalOccurrences: 12, startMonth: ym(-4), ...over });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.rule;
}

describe('anteprima: GET /api/transactions/:id/rate-impact', () => {
  it('rata di una regola a durata limitata: numero, avanzamento e nuova data finale', async () => {
    const c = await h.registerUser(server.base, 'ri1');
    const r = await limitedRule(c);
    const res = await c.get(`/api/transactions/${await txAt(r.id, -2)}/rate-impact`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      [res.body.applicable, res.body.ruleName, res.body.number, res.body.total, res.body.doneBefore, res.body.doneAfter, res.body.endBefore, res.body.endAfter, res.body.willGenerateNow],
      [true, 'Finanziamento', 3, 12, 5, 4, ym(7), ym(8), false]
    );
  });
  it('non applicabile: regola indeterminata, movimento libero, movimento fuori dal piano', async () => {
    const c = await h.registerUser(server.base, 'ri2');
    const open = await limitedRule(c, { name: 'Netflix', totalOccurrences: null });
    assert.equal((await c.get(`/api/transactions/${await txAt(open.id, 0)}/rate-impact`)).body.applicable, false);
    const free = await c.post('/api/transactions', { type: 'expense', amount: 5, occurredOn: mk(0) });
    assert.equal((await c.get(`/api/transactions/${free.body.transaction?.id ?? free.body.id}/rate-impact`)).body.applicable, false);
    // un movimento di una regola a rate spostato a mano prima dell'inizio del piano
    const r = await limitedRule(c, { name: 'Con strappo' });
    const tid = await txAt(r.id, -4);
    await h.query(`UPDATE transactions SET occurred_on = $2 WHERE id = $1`, [tid, `${ym(-8)}-01`]);
    assert.equal((await c.get(`/api/transactions/${tid}/rate-impact`)).body.applicable, false);
  });
  it('404 per un movimento inesistente o di un altro utente; 401 senza sessione', async () => {
    const a = await h.registerUser(server.base, 'ri3a');
    const b = await h.registerUser(server.base, 'ri3b');
    const r = await limitedRule(a);
    const tid = await txAt(r.id, 0);
    assert.equal((await b.get(`/api/transactions/${tid}/rate-impact`)).status, 404);
    assert.equal((await a.get('/api/transactions/999999/rate-impact')).status, 404);
    assert.equal((await new h.Client(server.base, null, null).get(`/api/transactions/${tid}/rate-impact`)).status, 401);
  });
});

describe('eliminazione di un movimento di una spesa fissa', () => {
  it('senza aggiornare le rate: il movimento sparisce, la rata resta contata (comportamento di prima)', async () => {
    const c = await h.registerUser(server.base, 'dl1');
    const r = await limitedRule(c);
    const res = await c.del(`/api/transactions/${await txAt(r.id, -2)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ratesUpdated, false);
    const after = await rule(c, r.id);
    assert.equal(after.progress.done, 5);
    assert.deepEqual(after.skippedMonths, []);
    assert.equal(after.progress.endMonth, ym(7));
    assert.equal((await months(r.id)).length, 4);
    await run(c);
    assert.equal((await months(r.id)).length, 4, 'il mese eliminato non viene ricreato');
  });

  it('aggiornando le rate: rata saltata, avanzamento -1, data finale +1 mese, nessuna rigenerazione', async () => {
    const c = await h.registerUser(server.base, 'dl2');
    const r = await limitedRule(c);
    const res = await c.del(`/api/transactions/${await txAt(r.id, -2)}?updateRates=true`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ratesUpdated, true);
    const after = await rule(c, r.id);
    assert.deepEqual(after.skippedMonths, [ym(-2)]);
    assert.equal(after.progress.done, 4);
    assert.equal(after.progress.remaining, 8);
    assert.equal(after.progress.endMonth, ym(8));
    assert.equal(after.progress.paid, 400, 'versato = somma reale dei movimenti');
    await run(c);
    assert.deepEqual(await months(r.id), [-4, -3, -1, 0].map(ym), 'il mese saltato non torna');
    // una seconda rata saltata sposta ancora la fine
    await c.del(`/api/transactions/${await txAt(r.id, -1)}?updateRates=true`);
    const again = await rule(c, r.id);
    assert.deepEqual(again.skippedMonths, [ym(-2), ym(-1)]);
    assert.equal(again.progress.endMonth, ym(9));
    assert.equal(again.progress.done, 3);
  });

  it('il movimento già eliminato non si può "aggiornare" due volte; 404 su inesistente o di altri', async () => {
    const a = await h.registerUser(server.base, 'dl3a');
    const b = await h.registerUser(server.base, 'dl3b');
    const r = await limitedRule(a);
    const tid = await txAt(r.id, 0);
    assert.equal((await b.del(`/api/transactions/${tid}?updateRates=true`)).status, 404);
    assert.equal((await months(r.id)).length, 5, 'il movimento di A è intatto');
    assert.equal((await a.del(`/api/transactions/${tid}?updateRates=true`)).status, 200);
    assert.equal((await a.del(`/api/transactions/${tid}?updateRates=true`)).status, 404);
    assert.deepEqual((await rule(a, r.id)).skippedMonths, [ym(0)], 'saltata una sola volta');
  });

  it('updateRates su un movimento libero o di una regola indeterminata: si elimina e basta', async () => {
    const c = await h.registerUser(server.base, 'dl4');
    const open = await limitedRule(c, { name: 'Netflix', totalOccurrences: null });
    const res = await c.del(`/api/transactions/${await txAt(open.id, 0)}?updateRates=true`);
    assert.equal(res.status, 200); assert.equal(res.body.ratesUpdated, false);
    assert.deepEqual((await rule(c, open.id)).skippedMonths, []);
    const free = await c.post('/api/transactions', { type: 'expense', amount: 5, occurredOn: mk(0) });
    const del = await c.del(`/api/transactions/${free.body.transaction?.id ?? free.body.id}?updateRates=true`);
    assert.equal(del.status, 200); assert.equal(del.body.ratesUpdated, false);
  });

  it('regola conclusa: eliminando l’ultima rata con aggiornamento torna attiva e la rata si riaddebita in coda', async () => {
    const c = await h.registerUser(server.base, 'dl5');
    const r = (await c.post('/api/recurring', { name: 'Tre rate', amount: 50, dayOfMonth: 1, totalOccurrences: 3, startMonth: ym(-5) })).body.rule;
    // il piano è finito 3 mesi fa: la regola si è disattivata da sola
    assert.deepEqual(await months(r.id), [-5, -4, -3].map(ym));
    assert.equal((await rule(c, r.id)).active, false);
    assert.equal((await rule(c, r.id)).progress.completed, true);
    const imp = await c.get(`/api/transactions/${await txAt(r.id, -3)}/rate-impact`);
    assert.equal(imp.body.endAfter, ym(-2));
    assert.equal(imp.body.willGenerateNow, true);
    const res = await c.del(`/api/transactions/${await txAt(r.id, -3)}?updateRates=true`);
    assert.equal(res.body.reactivated, true);
    assert.equal(res.body.generated, 1, 'la nuova ultima rata è già dovuta: si crea subito');
    assert.deepEqual(await months(r.id), [-5, -4, -2].map(ym));
    const after = await rule(c, r.id);
    assert.deepEqual(after.skippedMonths, [ym(-3)]);
    assert.equal(after.progress.completed, true);
    assert.equal(after.progress.endMonth, ym(-2));
    assert.equal(after.active, false, 'conclusa di nuovo, da sola');
  });

  it('regola disattivata a mano (non conclusa): non si riattiva', async () => {
    const c = await h.registerUser(server.base, 'dl6');
    const r = await limitedRule(c);
    await c.patch(`/api/recurring/${r.id}`, { active: false });
    await c.del(`/api/transactions/${await txAt(r.id, -1)}?updateRates=true`);
    assert.equal((await rule(c, r.id)).active, false);
  });

  it('annuale: la rata saltata sposta la fine di un anno', async () => {
    const c = await h.registerUser(server.base, 'dl7');
    const month = new Date().getUTCMonth() + 1;
    const y = new Date().getUTCFullYear();
    const r = (await c.post('/api/recurring', { name: 'Assicurazione', amount: 300, cadence: 'yearly', month, dayOfMonth: 1, totalOccurrences: 4, startMonth: `${y - 2}-${String(month).padStart(2, '0')}` })).body.rule;
    const before = await rule(c, r.id);
    assert.equal(before.progress.endMonth, `${y + 1}-${String(month).padStart(2, '0')}`);
    const tx = (await h.query(`SELECT id FROM transactions WHERE recurring_rule_id = $1 ORDER BY occurred_on LIMIT 1`, [r.id])).rows[0].id;
    await c.del(`/api/transactions/${tx}?updateRates=true`);
    const after = await rule(c, r.id);
    assert.equal(after.progress.endMonth, `${y + 2}-${String(month).padStart(2, '0')}`);
    assert.equal(after.progress.done, before.progress.done - 1);
  });

  it('cambiando poi la data di inizio le rate saltate si spostano insieme ai movimenti', async () => {
    const c = await h.registerUser(server.base, 'dl8');
    const r = await limitedRule(c);
    await c.del(`/api/transactions/${await txAt(r.id, -2)}?updateRates=true`);
    const res = await c.patch(`/api/recurring/${r.id}`, { startMonth: ym(-3) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.rule.skippedMonths, [ym(-1)], 'la rata saltata avanza di un mese come tutto il piano');
    assert.deepEqual(await months(r.id), [-3, -2, 0, 1].map(ym).sort());
  });
});

describe('backup e ripristino delle rate saltate', () => {
  it('lo stato delle rate saltate sopravvive a backup e ripristino personali; un vecchio backup senza la colonna si ripristina', async () => {
    const c = await h.registerUser(server.base, 'bk1');
    const r = await limitedRule(c);
    await c.del(`/api/transactions/${await txAt(r.id, -2)}?updateRates=true`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-rates-'));
    try {
      const dir = await core.createUserBackup({ userId: c.user.id, email: c.user.email, root });
      assert.match(fs.readFileSync(path.join(dir, 'recurring_rules.csv'), 'utf8').split('\n')[0], /skipped_months/);
      await h.query(`UPDATE recurring_rules SET skipped_months = '' WHERE user_id = $1`, [c.user.id]);
      await restoreUserBackup({ userId: c.user.id, dir });
      const restored = (await h.query('SELECT skipped_months FROM recurring_rules WHERE user_id = $1', [c.user.id])).rows[0];
      assert.equal(restored.skipped_months, ym(-2));
      // backup di un formato più vecchio: la colonna manca nel CSV → default ''
      const csv = path.join(dir, 'recurring_rules.csv');
      const lines = fs.readFileSync(csv, 'utf8').split('\n');
      const { parse } = require('csv-parse/sync');
      const { stringify } = require('csv-stringify/sync');
      const recs = parse(fs.readFileSync(csv, 'utf8'), { columns: true });
      recs.forEach((x) => delete x.skipped_months);
      fs.writeFileSync(csv, stringify(recs, { header: true }));
      assert.ok(lines.length > 1);
      await restoreUserBackup({ userId: c.user.id, dir });
      const old = (await h.query('SELECT skipped_months FROM recurring_rules WHERE user_id = $1', [c.user.id])).rows[0];
      assert.equal(old.skipped_months, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

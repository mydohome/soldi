'use strict';

// Misure emerse dall'audit di sicurezza: limite di login per account (non aggirabile con
// X-Forwarded-For), segreto di sessione di esempio rifiutato, algoritmo JWT fissato, limite
// sulla data di inizio delle spese fisse, nessuna differenza di risposta per utenti inesistenti.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers');

const tokens = require('../src/auth/tokens');

let server;
before(async () => {
  await h.prepareDatabase();
  server = await h.startServer();
});
after(async () => {
  await server.stop();
  await h.closePool();
});

const login = (base, email, password, ip) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify({ email, password }),
  });

describe('login: limite per account', () => {
  it('con TRUST_PROXY=1 il limite per IP si aggira ma quello per account no (10 errori → 429)', async () => {
    const srv = await h.startServer({ TRUST_PROXY: '1' });
    try {
      const codes = [];
      for (let i = 0; i < 14; i++) codes.push((await login(srv.base, 'bersaglio', 'sbagliata-123', `10.1.0.${i}`)).status);
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
      assert.deepEqual(codes.slice(10), Array(4).fill(429));
      // un altro account non è toccato
      assert.equal((await login(srv.base, 'altro-utente', 'sbagliata-123', '10.1.1.1')).status, 401);
      // nemmeno cambiando maiuscole/spazi si cambia chiave
      assert.equal((await login(srv.base, '  BERSAGLIO ', 'sbagliata-123', '10.1.2.2')).status, 429);
    } finally {
      await srv.stop();
    }
  });

  it('i login riusciti non consumano il limite; il blocco risponde con un messaggio chiaro', async () => {
    const srv = await h.startServer({ TRUST_PROXY: '1', LOGIN_ACCOUNT_MAX: '3' });
    try {
      const c = await h.registerUser(srv.base, 'lim');
      const email = c.user.email;
      for (let i = 0; i < 6; i++) assert.equal((await login(srv.base, email, h.PASSWORD, `10.2.0.${i}`)).status, 200);
      for (let i = 0; i < 3; i++) assert.equal((await login(srv.base, email, 'sbagliata-123', `10.2.1.${i}`)).status, 401);
      const blocked = await login(srv.base, email, h.PASSWORD, '10.2.2.2');
      assert.equal(blocked.status, 429);
      assert.match((await blocked.json()).message, /Troppi tentativi/);
    } finally {
      await srv.stop();
    }
  });

  it('un utente inesistente e una password sbagliata hanno la stessa risposta', async () => {
    const c = await h.registerUser(server.base, 'enum');
    const a = await login(server.base, 'non-esiste-proprio', 'sbagliata-123');
    const b = await login(server.base, c.user.email, 'sbagliata-123');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json());
  });
});

describe('segreto di sessione', () => {
  const withEnv = (env, fn) => {
    const saved = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('in produzione rifiuta segreto mancante, corto o di esempio; accetta uno casuale', () => {
    const prod = { NODE_ENV: 'production' };
    assert.throws(() => withEnv({ ...prod, JWT_SECRET: undefined }, tokens.assertSecret), /JWT_SECRET/);
    assert.throws(() => withEnv({ ...prod, JWT_SECRET: 'corto' }, tokens.assertSecret), /almeno 16/);
    assert.throws(() => withEnv({ ...prod, JWT_SECRET: 'change-me-to-a-long-random-string' }, tokens.assertSecret), /valore di esempio/);
    assert.throws(() => withEnv({ ...prod, JWT_SECRET: 'Change_Me-please-now-1234' }, tokens.assertSecret), /valore di esempio/, 'variante con maiuscole e underscore');
    withEnv({ ...prod, JWT_SECRET: 'a3f9c1d27e8b4650a3f9c1d27e8b4650' }, () => tokens.assertSecret());
  });

  it('fuori dalla produzione non blocca (sviluppo e test)', () => {
    withEnv({ NODE_ENV: 'development', JWT_SECRET: 'change-me-to-a-long-random-string' }, () => tokens.assertSecret());
  });

  it('con il segreto di esempio in produzione anche firmare/verificare è rifiutato', () => {
    withEnv({ NODE_ENV: 'production', JWT_SECRET: 'change-me-to-a-long-random-string' }, () => {
      assert.throws(() => tokens.signSession({ id: 1, email: 'x' }), /valore di esempio/);
    });
  });

  it('il token è firmato HS256 e uno con altro algoritmo (o senza firma) è rifiutato', () => {
    const secret = 'a3f9c1d27e8b4650a3f9c1d27e8b4650';
    withEnv({ JWT_SECRET: secret }, () => {
      const t = tokens.signSession({ id: 7, email: 'u@test' });
      assert.equal(jwt.decode(t, { complete: true }).header.alg, 'HS256');
      assert.equal(tokens.verifySession(t).sub, '7');
      const hs512 = jwt.sign({ sub: '7', email: 'u@test' }, secret, { algorithm: 'HS512' });
      assert.throws(() => tokens.verifySession(hs512), /invalid algorithm/);
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"7"}').toString('base64url')}.`;
      assert.throws(() => tokens.verifySession(none));
    });
  });
});

describe('spese fisse: limite sulla data di inizio nel passato', () => {
  const ym = (years, extraMonths = 0) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth() + extraMonths, 1)).toISOString().slice(0, 7);
  };
  const rule = (over) => ({ name: 'R', amount: 1, dayOfMonth: 1, ...over });
  let c;
  before(async () => {
    c = await h.registerUser(server.base, 'rec-lim');
  });

  it('un inizio nel 1000 è rifiutato e non crea nulla', async () => {
    const res = await c.post('/api/recurring', rule({ startMonth: '1000-01' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'start_too_old');
    const n = (await h.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [c.user.id])).rows[0].n;
    assert.equal(n, 0);
    assert.equal((await h.query('SELECT count(*)::int AS n FROM recurring_rules WHERE user_id = $1', [c.user.id])).rows[0].n, 0);
  });

  it('esattamente 10 anni fa è accettato, un mese prima no', async () => {
    assert.equal((await c.post('/api/recurring', rule({ startMonth: ym(-10, 1) }))).status, 201);
    assert.equal((await c.post('/api/recurring', rule({ startMonth: ym(-10, -1) }))).status, 400);
    const edge = await c.post('/api/recurring', rule({ startMonth: ym(-10) }));
    assert.equal(edge.status, 201);
  });

  it('PATCH: il limite vale solo se la data cambia (una regola storica resta modificabile)', async () => {
    const res = await c.post('/api/recurring', rule({ name: 'Storica', startMonth: ym(-1) }));
    const id = res.body.rule.id;
    await h.query(`UPDATE recurring_rules SET start_month = '2000-01-01', last_run_month = date_trunc('month', CURRENT_DATE) WHERE id = $1`, [id]);
    // stessa data di inizio (come fa l'interfaccia a ogni salvataggio): consentito
    assert.equal((await c.patch(`/api/recurring/${id}`, { name: 'Storica 2', startMonth: '2000-01' })).status, 200);
    // cambiarla verso una data troppo vecchia: rifiutato, anche in anteprima
    assert.equal((await c.patch(`/api/recurring/${id}`, { startMonth: '1500-01' })).status, 400);
    assert.equal((await c.get(`/api/recurring/${id}/start-preview?startMonth=1500-01`)).status, 400);
    assert.equal((await c.patch(`/api/recurring/${id}`, { startMonth: ym(-2) })).status, 200);
  });
});

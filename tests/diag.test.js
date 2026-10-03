'use strict';

// H2 — diagnostica (npm run diag): controlli in sola lettura su un database sano e su uno
// con dati volutamente incoerenti.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');

const { runDiagnostics } = require('../src/diag/checks');
const { createUser } = require('../src/auth/users');
const { encrypt } = require('../src/crypto/secrets');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const GOOD_ENV = {
  JWT_SECRET: 'x'.repeat(40), SECRETS_KEY: KEY_A, PGPASSWORD: 'unaltrapassword', ALLOW_REGISTRATION: 'false',
  HTTPS_ENABLED: 'false', COOKIE_SECURE: 'false', BACKUP_DIR: '/nonexistent-soldi-backups',
};

before(async () => {
  await h.prepareDatabase();
});
after(async () => {
  await h.closePool();
});
beforeEach(async () => {
  await h.truncateAll();
});

const run = (opts = {}) => runDiagnostics({ pool: h.pool, env: GOOD_ENV, ...opts });
const find = (res, id) => res.checks.find((c) => c.id === id);

async function twoUsers() {
  const a = await createUser({ email: 'a@test.local', password: h.PASSWORD, displayName: 'A' });
  const b = await createUser({ email: 'b@test.local', password: h.PASSWORD, displayName: 'B' });
  const cat = async (u, name, kind = 'expense') =>
    Number((await h.query(`INSERT INTO categories (user_id, name, kind) VALUES ($1, $2, $3) RETURNING id`, [u.id, name, kind])).rows[0].id);
  const acc = async (u, name) => Number((await h.query(`INSERT INTO accounts (user_id, name) VALUES ($1, $2) RETURNING id`, [u.id, name])).rows[0].id);
  return { a, b, cat, acc };
}

describe('diag — database sano', () => {
  it('nessun avviso né errore; tutti i controlli attesi presenti', async () => {
    const { a, cat, acc } = await twoUsers();
    const c = await cat(a, 'Spesa di prova'); const ac = await acc(a, 'Conto');
    await h.query(`INSERT INTO transactions (user_id, type, amount_cents, category_id, account_id, occurred_on) VALUES ($1,'expense',100,$2,$3,'2026-01-01')`, [a.id, c, ac]);
    const res = await run({ dataOnly: true });
    assert.deepEqual(res.checks.filter((x) => x.level !== 'ok'), [], JSON.stringify(res.checks.filter((x) => x.level !== 'ok')));
    assert.equal(res.exitCode, 0);
    assert.equal(res.ok, true);
    for (const id of ['schema_tables', 'schema_columns', 'schema_indexes', 'schema_constraints', 'schema_not_valid', 'identity_sequences', 'users_duplicate_email', 'cross_user_refs', 'telegram_decrypt']) {
      assert.ok(find(res, id), `manca il controllo ${id}`);
    }
    assert.match(find(res, 'schema_indexes').message, /uq_tx_rule_month/);
    assert.equal(res.info.rows.transactions, 1);
    assert.ok(res.info.postgres);
    assert.ok(res.info.databaseBytes > 0);
  });

  it('i vincoli NOT VALID senza righe fuori regola non sono un avviso', async () => {
    const res = await run({ dataOnly: true });
    assert.equal(find(res, 'schema_not_valid').level, 'ok');
    assert.match(find(res, 'schema_not_valid').message, /recurring_yearly_month_check/);
  });

  it('è davvero in sola lettura (nessuna scrittura, la transazione è READ ONLY)', async () => {
    await twoUsers();
    const before = (await h.query('SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM categories) c')).rows[0];
    await run();
    const after = (await h.query('SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM categories) c')).rows[0];
    assert.deepEqual(after, before);
    // una scrittura dentro la stessa modalità fallirebbe: lo si verifica con una transazione READ ONLY analoga
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await assert.rejects(client.query(`INSERT INTO users (email, password_hash) VALUES ('x','y')`), /read-only/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});

describe('diag — dati volutamente incoerenti', () => {
  it('annuali senza mese + vincolo NOT VALID con violazioni → avviso', async () => {
    const { a } = await twoUsers();
    await h.query('ALTER TABLE recurring_rules DROP CONSTRAINT recurring_yearly_month_check');
    await h.query('ALTER TABLE planned_expenses DROP CONSTRAINT planned_yearly_month_check');
    await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, cadence) VALUES ($1,'annuale rotta',500,'yearly')`, [a.id]);
    await h.query(`INSERT INTO planned_expenses (user_id, name, amount_cents, cadence) VALUES ($1,'prevista rotta',500,'yearly')`, [a.id]);
    await h.query(`ALTER TABLE recurring_rules ADD CONSTRAINT recurring_yearly_month_check CHECK (cadence <> 'yearly' OR month IS NOT NULL) NOT VALID`);
    await h.query(`ALTER TABLE planned_expenses ADD CONSTRAINT planned_yearly_month_check CHECK (cadence <> 'yearly' OR month IS NOT NULL) NOT VALID`);
    const res = await run({ dataOnly: true });
    assert.equal(find(res, 'yearly_without_month').level, 'warn');
    assert.equal(find(res, 'yearly_without_month').count, 2);
    assert.equal(find(res, 'schema_not_valid').level, 'warn');
    assert.equal(res.exitCode, 2);
  });

  it('categoria di tipo diverso da movimento e regola → avviso', async () => {
    const { a, cat } = await twoUsers();
    const income = await cat(a, 'Entrata di prova', 'income');
    await h.query(`INSERT INTO transactions (user_id, type, amount_cents, category_id) VALUES ($1,'expense',100,$2)`, [a.id, income]);
    await h.query(`INSERT INTO recurring_rules (user_id, name, type, amount_cents, category_id) VALUES ($1,'r','expense',100,$2)`, [a.id, income]);
    const res = await run({ dataOnly: true });
    assert.equal(find(res, 'kind_mismatch').level, 'warn');
    assert.equal(find(res, 'kind_mismatch').count, 2);
  });

  it('riferimenti tra utenti diversi → ERRORE (isolamento)', async () => {
    const { a, b, cat, acc } = await twoUsers();
    const catB = await cat(b, 'Di B'); const accB = await acc(b, 'Conto di B');
    await h.query(`INSERT INTO transactions (user_id, type, amount_cents, category_id) VALUES ($1,'expense',100,$2)`, [a.id, catB]);
    await h.query(`INSERT INTO transactions (user_id, type, amount_cents, account_id) VALUES ($1,'expense',100,$2)`, [a.id, accB]);
    await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, category_id) VALUES ($1,'r',100,$2)`, [a.id, catB]);
    await h.query(`INSERT INTO planned_expenses (user_id, name, amount_cents, category_id) VALUES ($1,'p',100,$2)`, [a.id, catB]);
    const res = await run({ dataOnly: true });
    assert.equal(find(res, 'cross_user_refs').level, 'error');
    assert.equal(find(res, 'cross_user_refs').count, 4);
    assert.equal(res.exitCode, 1);
    assert.ok(!JSON.stringify(res).includes('b@test.local'), 'nessun dato personale nell’output');
  });

  it('ricorrenze: cron fermo, durata oltrepassata, movimenti in eccesso', async () => {
    const { a } = await twoUsers();
    // attiva, in ritardo di mesi
    await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, start_month, last_run_month) VALUES ($1,'ferma',100,'2024-01-01','2024-03-01')`, [a.id]);
    // a durata limitata, finita nel 2020 ma ancora attiva
    await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, total_occurrences, start_month, last_run_month) VALUES ($1,'finita',100,3,'2020-01-01','2020-03-01')`, [a.id]);
    // più movimenti del totale
    const r = (await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, total_occurrences, active, start_month) VALUES ($1,'troppi',100,1,false,'2025-01-01') RETURNING id`, [a.id])).rows[0].id;
    await h.query(`INSERT INTO transactions (user_id, type, amount_cents, recurring_rule_id, occurred_on) VALUES ($1,'expense',100,$2,'2025-01-01'),($1,'expense',100,$2,'2025-02-01')`, [a.id, r]);
    const res = await run({ dataOnly: true, now: new Date('2026-10-03T10:00:00Z') });
    assert.equal(find(res, 'recurring_stale').level, 'warn');
    assert.equal(find(res, 'recurring_stale').count, 2);
    assert.equal(find(res, 'recurring_overdue').level, 'warn');
    assert.equal(find(res, 'recurring_overdue').count, 1);
    assert.equal(find(res, 'recurring_excess').level, 'warn');
    assert.equal(find(res, 'recurring_excess').count, 1);
  });

  it('una regola aggiornata e una non ancora iniziata non danno avvisi', async () => {
    const { a } = await twoUsers();
    await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, start_month, last_run_month) VALUES ($1,'ok',100,'2026-01-01','2026-09-01')`, [a.id]);
    await h.query(`INSERT INTO recurring_rules (user_id, name, amount_cents, start_month) VALUES ($1,'futura',100,'2027-01-01')`, [a.id]);
    const res = await run({ dataOnly: true, now: new Date('2026-10-03T10:00:00Z') });
    assert.equal(find(res, 'recurring_stale').level, 'ok');
  });

  it('sequenze IDENTITY indietro rispetto a MAX(id) → errore', async () => {
    const { a } = await twoUsers();
    await h.query(`INSERT INTO transactions (user_id, type, amount_cents) VALUES ($1,'expense',100),($1,'expense',100)`, [a.id]);
    await h.query('ALTER TABLE transactions ALTER COLUMN id RESTART WITH 1');
    const res = await run({ dataOnly: true });
    assert.equal(find(res, 'identity_sequences').level, 'error');
    assert.match(find(res, 'identity_sequences').message, /transactions/);
  });

  it('email duplicate ignorando le maiuscole → errore (senza stampare le email)', async () => {
    await h.query(`INSERT INTO users (email, password_hash) VALUES ('Mario@Test.local','x'), ('mario@test.local','y')`);
    const res = await run({ dataOnly: true });
    assert.equal(find(res, 'users_duplicate_email').level, 'error');
    assert.ok(!JSON.stringify(res).toLowerCase().includes('mario@'));
  });

  it('Telegram: decifrabile con la chiave giusta, errore con una chiave diversa', async () => {
    const { a } = await twoUsers();
    process.env.SECRETS_KEY = KEY_A;
    await h.query(`INSERT INTO telegram_settings (user_id, bot_token_enc, chat_id_enc) VALUES ($1,$2,$3)`, [a.id, encrypt('123:SEGRETO'), encrypt('999')]);
    try {
      let res = await run({ dataOnly: true });
      assert.equal(find(res, 'telegram_decrypt').level, 'ok');
      process.env.SECRETS_KEY = KEY_B;
      res = await run({ dataOnly: true });
      assert.equal(find(res, 'telegram_decrypt').level, 'error');
      assert.ok(!JSON.stringify(res).includes('SEGRETO'), 'mai i valori');
      delete process.env.SECRETS_KEY;
      res = await run({ dataOnly: true });
      assert.equal(find(res, 'telegram_decrypt').level, 'error', 'senza chiave non è decifrabile');
    } finally { delete process.env.SECRETS_KEY; }
  });

  it('schema: indice o vincolo mancante → errore', async () => {
    await h.query('DROP INDEX uq_tx_rule_month');
    await h.query('ALTER TABLE transactions DROP CONSTRAINT transactions_scope_check');
    try {
      const res = await run({ dataOnly: true });
      assert.equal(find(res, 'schema_indexes').level, 'error');
      assert.match(find(res, 'schema_indexes').message, /uq_tx_rule_month/);
      assert.equal(find(res, 'schema_constraints').level, 'error');
    } finally {
      await h.prepareDatabase(); // schema idempotente: ricrea quanto tolto
    }
  });
});

describe('diag — configurazione e backup', () => {
  it('segnala configurazioni deboli', async () => {
    const res = await runDiagnostics({
      pool: h.pool, dataOnly: false,
      env: { JWT_SECRET: 'change-me-to-a-long-random-string', PGPASSWORD: 'soldi', ALLOW_REGISTRATION: 'true', HTTPS_ENABLED: 'true', COOKIE_SECURE: 'false', BACKUP_DIR: '/nonexistent' },
    });
    assert.equal(find(res, 'config_jwt').level, 'error');
    assert.equal(find(res, 'config_secrets_key').level, 'warn');
    assert.equal(find(res, 'config_pgpassword').level, 'warn');
    assert.equal(find(res, 'config_registration').level, 'warn');
    assert.equal(find(res, 'config_cookie').level, 'warn');
    assert.equal(find(res, 'backup_age').level, 'warn');
    for (const [env, level] of [[{ JWT_SECRET: '' }, 'error'], [{ JWT_SECRET: 'corto' }, 'warn']]) {
      const r = await runDiagnostics({ pool: h.pool, env: { ...GOOD_ENV, ...env } });
      assert.equal(find(r, 'config_jwt').level, level);
    }
    const bad = await runDiagnostics({ pool: h.pool, env: { ...GOOD_ENV, SECRETS_KEY: 'non-esadecimale' } });
    assert.equal(find(bad, 'config_secrets_key').level, 'error');
  });
  it('configurazione buona e --data-only la salta', async () => {
    const good = await run();
    assert.ok(good.checks.filter((c) => c.group === 'config').every((c) => c.level === 'ok'));
    const dataOnly = await run({ dataOnly: true });
    assert.equal(dataOnly.checks.filter((c) => c.group === 'config' || c.group === 'backup').length, 0);
  });
  it('età dell’ultimo backup', async () => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-diag-'));
    try {
      const b = path.join(dir, 'soldi-backup-2026-10-01_03-00-00-000'); fs.mkdirSync(b);
      fs.writeFileSync(path.join(b, 'manifest.json'), '{}');
      let res = await run({ env: { ...GOOD_ENV, BACKUP_DIR: dir } });
      assert.equal(find(res, 'backup_age').level, 'ok');
      res = await run({ env: { ...GOOD_ENV, BACKUP_DIR: dir }, now: new Date(Date.now() + 20 * 86400000) });
      assert.equal(find(res, 'backup_age').level, 'warn');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('diag — riga di comando', () => {
  const cli = (...args) =>
    spawnSync(process.execPath, ['scripts/diag.js', ...args], {
      cwd: h.ROOT, encoding: 'utf8', env: { ...process.env, ...h.PG, ...GOOD_ENV, PGPASSWORD: h.PG.PGPASSWORD },
    });

  it('testo, --json e codici di uscita', async () => {
    await twoUsers();
    const t = cli('--data-only');
    assert.equal(t.status, 0, t.stdout + t.stderr);
    assert.match(t.stdout, /Soldi — diagnostica/);
    assert.match(t.stdout, /Esito: \d+ ok, 0 avvisi, 0 errori/);
    const j = cli('--json', '--data-only');
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.exitCode, 0);
    assert.ok(Array.isArray(parsed.checks));
    // errore → 1
    await h.query(`INSERT INTO users (email, password_hash) VALUES ('Dup@x','x'), ('dup@x','y')`);
    assert.equal(cli('--data-only').status, 1);
    assert.equal(JSON.parse(cli('--json', '--data-only').stdout).exitCode, 1);
  });
  it('aiuto e database irraggiungibile', () => {
    assert.match(cli('--help').stdout, /Uso: npm run diag/);
    const r = spawnSync(process.execPath, ['scripts/diag.js'], { cwd: h.ROOT, encoding: 'utf8', env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '1' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Diagnostica non riuscita/);
  });
});

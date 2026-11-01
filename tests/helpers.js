'use strict';

/**
 * Harness per i test di integrazione (`npm run test:integration`).
 * Nessuna dipendenza: node:test + fetch globale. Avvia il server VERO come
 * processo figlio contro un Postgres di test e parla via HTTP.
 *
 * Sicurezza: rifiuta di girare se PGDATABASE non contiene "test", perché alcuni
 * test (ripristino globale) svuotano tutte le tabelle.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PG = {
  PGHOST: process.env.PGHOST || '127.0.0.1',
  PGPORT: process.env.PGPORT || '5432',
  PGUSER: process.env.PGUSER || 'soldi',
  PGPASSWORD: process.env.PGPASSWORD || 'soldi',
  PGDATABASE: process.env.PGDATABASE || 'soldi_test',
};
if (!/test/i.test(PG.PGDATABASE)) {
  throw new Error(`Rifiuto di eseguire i test su "${PG.PGDATABASE}": il nome del database deve contenere "test".`);
}
// Configura il pool usato dai test in-process (require('../src/db/pool')).
delete process.env.DATABASE_URL;
Object.assign(process.env, PG);

const { pool, query } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');

const PASSWORD = 'TestPass123!';
let counter = 0;
const uniqueEmail = (tag = 'u') => `${tag}-${process.pid}-${Date.now()}-${counter++}@test.local`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Avvia `node src/server.js` e attende che sia in ascolto. */
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-test-backups-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...PG,
      PORT: String(port),
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      ALLOW_REGISTRATION: 'true',
      BACKUP_ENABLED: 'false',
      RECURRING_ENABLED: 'false',
      BACKUP_DIR: backupDir,
      TRUST_PROXY: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server non avviato:\n${log}`)), 15000);
    const onData = (d) => {
      log += d;
      if (log.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (log += d));
    child.on('exit', (code) => reject(new Error(`Server terminato (${code}):\n${log}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    backupDir,
    log: () => log,
    async stop() {
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      fs.rmSync(backupDir, { recursive: true, force: true });
    },
  };
}

class Client {
  constructor(base, cookie, user) {
    this.base = base;
    this.cookie = cookie;
    this.user = user;
  }

  async request(method, url, body) {
    const res = await fetch(this.base + url, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }

  get = (url) => this.request('GET', url);
  post = (url, body) => this.request('POST', url, body ?? {});
  patch = (url, body) => this.request('PATCH', url, body ?? {});
  del = (url) => this.request('DELETE', url);
}

/** Registra un utente nuovo (con categorie e conti di default) e ritorna un client autenticato. */
async function registerUser(base, tag = 'u', fixedEmail = null) {
  const email = fixedEmail || uniqueEmail(tag);
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: tag }),
  });
  if (res.status !== 201) throw new Error(`register fallita: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  const { user } = await res.json();
  return new Client(base, cookie, { ...user, id: Number(user.id), email });
}

async function prepareDatabase() {
  await migrate();
}

/** Svuota tutte le tabelle (solo per test che lo richiedono, DB "test" garantito sopra). */
async function truncateAll() {
  await query('TRUNCATE users RESTART IDENTITY CASCADE');
}

async function closePool() {
  await pool.end();
}

module.exports = {
  ROOT,
  PG,
  PASSWORD,
  pool,
  query,
  Client,
  startServer,
  registerUser,
  prepareDatabase,
  truncateAll,
  closePool,
  uniqueEmail,
};

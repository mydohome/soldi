'use strict';

// Gruppo C1 — il ripristino globale (src/backup/restore.js) non deve svuotare il database.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');

const { createBackup, createUserBackup } = require('../src/backup/backup-core');
const { createUser } = require('../src/auth/users');

let root; // cartella con i backup di prova
before(async () => {
  await h.prepareDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-restore-test-'));
});
after(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await h.closePool();
});

const count = async (table) => (await h.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

let user;
beforeEach(async () => {
  await h.truncateAll();
  user = await createUser({ email: 'ripristino@test.local', password: h.PASSWORD, displayName: 'R' });
  const cat = await h.query('SELECT id FROM categories WHERE user_id = $1 LIMIT 1', [user.id]);
  for (let i = 1; i <= 4; i++) {
    await h.query(
      `INSERT INTO transactions (user_id, type, amount_cents, category_id, note, occurred_on)
       VALUES ($1, 'expense', $2, $3, $4, ('2026-03-1' || $5::text)::date)`,
      [user.id, i * 1000, cat.rows[0].id, `mov ${i}`, i]
    );
  }
});

function runRestore(dir) {
  const r = spawnSync(process.execPath, ['src/backup/restore.js', dir, '--yes'], {
    cwd: h.ROOT,
    env: { ...process.env, ...h.PG, BACKUP_DIR: root },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

async function snapshot() {
  return {
    users: await count('users'),
    categories: await count('categories'),
    accounts: await count('accounts'),
    transactions: await count('transactions'),
  };
}

describe('C1 — ripristino globale sicuro', () => {
  it('cartella senza CSV → errore e dati intatti', async () => {
    const before = await snapshot();
    const empty = fs.mkdtempSync(path.join(root, 'vuota-'));
    const r = runRestore(empty);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /users\.csv assente o vuoto/);
    assert.deepEqual(await snapshot(), before);
  });

  it('la cartella radice dei backup (nessun CSV dentro) → errore e dati intatti', async () => {
    const before = await snapshot();
    const r = runRestore(root);
    assert.notEqual(r.code, 0, r.out);
    assert.deepEqual(await snapshot(), before);
  });

  it('backup personale → errore che indica user:restore, dati intatti', async () => {
    const dir = await createUserBackup({ userId: user.id, email: user.email, root });
    const before = await snapshot();
    const r = runRestore(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /backup personale/);
    assert.match(r.out, /user:restore/);
    assert.deepEqual(await snapshot(), before);
  });

  it('manifest di tipo user su una cartella con users.csv → comunque rifiutato', async () => {
    const dir = await createBackup({ root });
    const mp = path.join(dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.kind = 'user';
    fs.writeFileSync(mp, JSON.stringify(m));
    const before = await snapshot();
    const r = runRestore(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /backup personale/);
    assert.deepEqual(await snapshot(), before);
  });

  it('users.csv con solo l’header → rifiutato', async () => {
    const dir = await createBackup({ root });
    const f = path.join(dir, 'users.csv');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n')[0] + '\n');
    const before = await snapshot();
    const r = runRestore(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /users\.csv assente o vuoto/);
    assert.deepEqual(await snapshot(), before);
  });

  it('CSV troncato rispetto al manifest → rollback, dati intatti', async () => {
    const dir = await createBackup({ root });
    const f = path.join(dir, 'transactions.csv');
    const lines = fs.readFileSync(f, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(f, lines.slice(0, 3).join('\n') + '\n'); // header + 2 righe su 4
    const before = await snapshot();
    const r = runRestore(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /transactions: attese 4 righe, trovate 2/);
    assert.deepEqual(await snapshot(), before);
  });

  it('transactions.csv mancante con manifest → rollback, dati intatti', async () => {
    const dir = await createBackup({ root });
    fs.rmSync(path.join(dir, 'transactions.csv'));
    const before = await snapshot();
    const r = runRestore(dir);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /transactions: attese 4 righe, trovate 0/);
    assert.deepEqual(await snapshot(), before);
  });

  it('backup valido → ripristino riuscito', async () => {
    const dir = await createBackup({ root });
    const before = await snapshot();
    await h.query('DELETE FROM transactions');
    await h.query("INSERT INTO accounts (user_id, name) VALUES ($1, 'Extra da cancellare')", [user.id]);
    const r = runRestore(dir);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(await snapshot(), before);
    assert.match(r.out, /transactions: 4 rows restored/);
  });

  it('backup senza manifest (formato vecchio) ma con CSV validi → ripristino riuscito', async () => {
    const dir = await createBackup({ root });
    fs.rmSync(path.join(dir, 'manifest.json'));
    const before = await snapshot();
    const r = runRestore(dir);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(await snapshot(), before);
    assert.match(r.out, /users: 1/); // riepilogo stampato anche senza manifest
  });
});

'use strict';

// Gruppo C2 — backup-core: ordinamento per timestamp, snapshot coerente, permessi.
// Gruppo C3 — restore-user: verifica del proprietario del backup.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');

const core = require('../src/backup/backup-core');
const { createUser } = require('../src/auth/users');
const { resolveUserBackupDir, restoreUserBackup } = require('../src/backup/restore-user');

let root;
before(async () => {
  await h.prepareDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-core-test-'));
});
after(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await h.closePool();
});
beforeEach(() => {
  for (const e of fs.readdirSync(root)) fs.rmSync(path.join(root, e), { recursive: true, force: true });
});

const mkdirs = (...names) => names.forEach((n) => fs.mkdirSync(path.join(root, n)));
const left = () => fs.readdirSync(root).sort();

describe('C2 — ordinamento per timestamp, non per nome', () => {
  it('listUserBackups, --latest e pulizia seguono il tempo anche se lo slug cambia', () => {
    mkdirs(
      'soldi-user-backup-7-zeta-2026-01-01_00-00-00-000', // più vecchio, slug alfabeticamente ultimo
      'soldi-user-backup-7-alfa-2026-02-01_00-00-00-000',
      'soldi-user-backup-7-mario-2026-03-01_00-00-00-000' // più recente
    );
    const list = core.listUserBackups(7, root);
    assert.deepEqual(list.map((n) => n.slice(-23)), [
      '2026-01-01_00-00-00-000',
      '2026-02-01_00-00-00-000',
      '2026-03-01_00-00-00-000',
    ]);
    assert.match(resolveUserBackupDir(7, '--latest', root), /mario-2026-03-01/);
  });

  it('formati misti: timestamp senza millisecondi (backup vecchi) e con millisecondi', () => {
    mkdirs(
      'soldi-user-backup-7-mario-2026-09-13_03-00-00', // vecchio formato (19 caratteri)
      'soldi-user-backup-7-mario-2026-09-20_03-00-00-250', // nuovo formato, più recente
      'soldi-user-backup-7-anna-2026-09-13_03-00-00-500' // stesso secondo del vecchio ma dopo
    );
    assert.deepEqual(
      core.listUserBackups(7, root),
      [
        'soldi-user-backup-7-mario-2026-09-13_03-00-00',
        'soldi-user-backup-7-anna-2026-09-13_03-00-00-500',
        'soldi-user-backup-7-mario-2026-09-20_03-00-00-250',
      ]
    );
  });

  it('il vecchio formato con lo slug lungo non supera mai un backup più recente', () => {
    mkdirs(
      'soldi-user-backup-7-zzzzzzzz-2026-01-05_03-00-00', // vecchio formato, slug "alto"
      'soldi-user-backup-7-a-2026-09-18_03-00-00-100'
    );
    const list = core.listUserBackups(7, root);
    assert.match(list[list.length - 1], /2026-09-18/);
    assert.match(resolveUserBackupDir(7, '--latest', root), /2026-09-18/);
  });

  it('pruneOldDirs elimina il più vecchio per timestamp', async () => {
    const user = await createUser({ email: `prune-${Date.now()}@test.local`, password: h.PASSWORD });
    const p = (slug, ts) => `soldi-user-backup-${user.id}-${slug}-${ts}`;
    mkdirs(p('zeta', '2026-01-01_00-00-00-000'), p('alfa', '2026-02-01_00-00-00-000'));
    // il nuovo backup (slug dall'email) è il più recente: con keep=2 deve sparire il più vecchio
    await core.createUserBackup({ userId: user.id, email: user.email, root, keep: 2 });
    const names = left();
    assert.equal(names.length, 2);
    assert.ok(!names.some((n) => n.includes('zeta-2026-01-01')), `rimasti: ${names}`);
    assert.ok(names.some((n) => n.includes('alfa-2026-02-01')));
  });

  it('backup globali: ordinati per timestamp', () => {
    mkdirs('soldi-backup-2026-09-13_03-00-00', 'soldi-backup-2026-09-20_03-00-00-250', 'soldi-backup-2026-09-13_03-00-00-500');
    const { byTimestamp } = core;
    assert.deepEqual(left().sort(byTimestamp), [
      'soldi-backup-2026-09-13_03-00-00',
      'soldi-backup-2026-09-13_03-00-00-500',
      'soldi-backup-2026-09-20_03-00-00-250',
    ]);
  });
});

describe('C2 — snapshot coerente', () => {
  it('withSnapshot: REPEATABLE READ, sola lettura, vede un solo istante', async () => {
    await core.withSnapshot(async (client) => {
      const iso = (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
      const ro = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      assert.equal(iso, 'repeatable read');
      assert.equal(ro, 'on');

      const n1 = (await client.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
      await createUser({ email: `snap-${Date.now()}@test.local`, password: h.PASSWORD }); // altra connessione
      const n2 = (await client.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
      assert.equal(n2, n1, 'la scrittura concorrente non deve comparire nello snapshot');
    });
    // fuori dallo snapshot la riga c'è
    assert.ok((await h.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n > 0);
  });

  it('un errore dentro lo snapshot fa rollback e rilascia la connessione', async () => {
    await assert.rejects(
      core.withSnapshot(async (client) => {
        await client.query('SELECT 1');
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal((await h.query('SELECT 1 AS x')).rows[0].x, 1);
  });
});

describe('C2 — permessi dei backup', () => {
  it('cartelle 0700 e file 0600 (globale e personale)', async function (t) {
    if (process.platform === 'win32') return t.skip('permessi POSIX');
    const user = await createUser({ email: `perm-${Date.now()}@test.local`, password: h.PASSWORD });
    for (const dir of [await core.createBackup({ root }), await core.createUserBackup({ userId: user.id, email: user.email, root })]) {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${dir} dovrebbe essere 0700`);
      for (const f of fs.readdirSync(dir)) {
        assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} dovrebbe essere 0600`);
      }
    }
  });

  it('anche con una umask permissiva (000) i permessi restano restrittivi', async (t) => {
    if (process.platform === 'win32') return t.skip('permessi POSIX');
    const user = await createUser({ email: `umask-${Date.now()}@test.local`, password: h.PASSWORD });
    const old = process.umask(0);
    try {
      const dir = await core.createUserBackup({ userId: user.id, email: user.email, root });
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mode & 0o777, 0o600);
    } finally {
      process.umask(old);
    }
  });
});

describe('C3 — restore-user: proprietario del backup', () => {
  let a;
  let b;
  beforeEach(async () => {
    await h.truncateAll();
    a = await createUser({ email: 'utente-a@test.local', password: h.PASSWORD, displayName: 'A' });
    b = await createUser({ email: 'utente-b@test.local', password: h.PASSWORD, displayName: 'B' });
    await h.query("INSERT INTO accounts (user_id, name) VALUES ($1, 'Conto di A')", [a.id]);
    await h.query("INSERT INTO accounts (user_id, name) VALUES ($1, 'Conto di B')", [b.id]);
  });

  const accountsOf = async (id) =>
    (await h.query('SELECT name FROM accounts WHERE user_id = $1 ORDER BY name', [id])).rows.map((r) => r.name);

  function cli(args) {
    const r = spawnSync(process.execPath, ['src/scripts/user-restore.js', ...args, '--yes'], {
      cwd: h.ROOT,
      env: { ...process.env, ...h.PG, BACKUP_DIR: root },
      encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  }

  it('ripristino del proprio backup → ok', async () => {
    const dir = await core.createUserBackup({ userId: a.id, email: a.email, root });
    await h.query("DELETE FROM accounts WHERE user_id = $1 AND name = 'Conto di A'", [a.id]);
    await restoreUserBackup({ userId: a.id, dir });
    assert.ok((await accountsOf(a.id)).includes('Conto di A'));
  });

  it('backup di un altro utente → errore e dati intatti', async () => {
    const dirA = await core.createUserBackup({ userId: a.id, email: a.email, root });
    const before = await accountsOf(b.id);
    await assert.rejects(restoreUserBackup({ userId: b.id, dir: dirA }), /utente-a@test\.local.*--force/);
    assert.deepEqual(await accountsOf(b.id), before);
    assert.ok(!(await accountsOf(b.id)).includes('Conto di A'));
  });

  it('con force il backup di un altro utente viene applicato', async () => {
    const dirA = await core.createUserBackup({ userId: a.id, email: a.email, root });
    await restoreUserBackup({ userId: b.id, dir: dirA, force: true });
    assert.ok((await accountsOf(b.id)).includes('Conto di A'));
    assert.ok(!(await accountsOf(b.id)).includes('Conto di B'));
    assert.ok((await accountsOf(a.id)).includes('Conto di A')); // A non è toccato
  });

  it('un backup globale non è un backup personale (nemmeno con force)', async () => {
    const dirG = await core.createBackup({ root });
    const before = await accountsOf(b.id);
    await assert.rejects(restoreUserBackup({ userId: b.id, dir: dirG, force: true }), /Non è un backup personale/);
    assert.deepEqual(await accountsOf(b.id), before);
  });

  it('CLI: senza --force rifiuta, con --force applica; il flag funziona in qualsiasi posizione', async () => {
    const dirA = await core.createUserBackup({ userId: a.id, email: a.email, root });
    const before = await accountsOf(b.id);

    const refused = cli([b.email, path.basename(dirA)]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /--force/);
    assert.deepEqual(await accountsOf(b.id), before);

    const ok = cli([b.email, '--force', path.basename(dirA)]);
    assert.equal(ok.code, 0, ok.out);
    assert.ok((await accountsOf(b.id)).includes('Conto di A'));
  });

  it('CLI: il proprio backup con --latest funziona come prima', async () => {
    await core.createUserBackup({ userId: a.id, email: a.email, root });
    const r = cli([a.email, '--latest']);
    assert.equal(r.code, 0, r.out);
  });
});

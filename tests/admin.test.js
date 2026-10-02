'use strict';

// Aggiornamento dall'app riservato all'amministratore (routes/settings.js).
// Amministratore = il primo utente creato, oppure ADMIN_EMAIL se impostata.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(async () => {
  await h.prepareDatabase();
});
after(async () => {
  await h.closePool();
});

// REPO_DIR inesistente: nessun test può eseguire un vero git pull / riavvio.
const NO_REPO = { REPO_DIR: '/nonexistent-repo-dir' };

describe('amministratore = primo utente creato', () => {
  let server;
  let first;
  let second;
  before(async () => {
    await h.truncateAll(); // il "primo utente" dipende dall'intero database di test
    server = await h.startServer({ ...NO_REPO, SELF_UPDATE_ENABLED: 'true' });
    first = await h.registerUser(server.base, 'admin-first');
    second = await h.registerUser(server.base, 'admin-second');
  });
  after(async () => {
    await server.stop();
  });

  it('un utente normale non può controllare né applicare aggiornamenti (403 admin_only)', async () => {
    const check = await second.get('/api/settings/check-update');
    assert.equal(check.status, 403, JSON.stringify(check.body));
    assert.equal(check.body.error, 'admin_only');
    const upd = await second.post('/api/settings/update');
    assert.equal(upd.status, 403, JSON.stringify(upd.body));
    assert.equal(upd.body.error, 'admin_only');
  });

  it('il primo utente passa il controllo (fallisce solo perché il repo non è montato)', async () => {
    const check = await first.get('/api/settings/check-update');
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.supported, false);
    const upd = await first.post('/api/settings/update');
    assert.equal(upd.status, 500);
    assert.equal(upd.body.error, 'no_repo_mount');
  });

  it('senza sessione: 401', async () => {
    const anon = new h.Client(server.base, null, null);
    assert.equal((await anon.get('/api/settings/check-update')).status, 401);
    assert.equal((await anon.post('/api/settings/update')).status, 401);
  });

  it('/version resta per tutti e dice se chi chiede è amministratore', async () => {
    const a = await first.get('/api/settings/version');
    const b = await second.get('/api/settings/version');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.isAdmin, true);
    assert.equal(b.body.isAdmin, false);
  });

  it('con SELF_UPDATE_ENABLED=false l’amministratore riceve self_update_disabled, gli altri admin_only', async () => {
    const s = await h.startServer({ ...NO_REPO, SELF_UPDATE_ENABLED: 'false' });
    try {
      const adminClient = new h.Client(s.base, first.cookie, first.user);
      const userClient = new h.Client(s.base, second.cookie, second.user);
      const a = await adminClient.post('/api/settings/update');
      assert.equal(a.status, 403);
      assert.equal(a.body.error, 'self_update_disabled');
      const u = await userClient.post('/api/settings/update');
      assert.equal(u.status, 403);
      assert.equal(u.body.error, 'admin_only');
    } finally {
      await s.stop();
    }
  });
});

describe('ADMIN_EMAIL', () => {
  it('se impostata, solo quell’utente è amministratore (anche se non è il primo, maiuscole ignorate)', async () => {
    await h.truncateAll();
    const server = await h.startServer({ ...NO_REPO, SELF_UPDATE_ENABLED: 'true', ADMIN_EMAIL: ' Capo@Test.Local ' });
    try {
      const first = await h.registerUser(server.base, 'first');
      const boss = await h.registerUser(server.base, 'boss', 'capo@test.local');
      assert.equal((await first.get('/api/settings/version')).body.isAdmin, false);
      assert.equal((await boss.get('/api/settings/version')).body.isAdmin, true);
      assert.equal((await first.get('/api/settings/check-update')).status, 403);
      assert.equal((await boss.get('/api/settings/check-update')).status, 200);
      assert.equal((await boss.post('/api/settings/update')).body.error, 'no_repo_mount');
    } finally {
      await server.stop();
    }
  });

  it('se non corrisponde a nessun utente nessuno è amministratore (si chiude, non si apre)', async () => {
    await h.truncateAll();
    const server = await h.startServer({ ...NO_REPO, SELF_UPDATE_ENABLED: 'true', ADMIN_EMAIL: 'nessuno@test.local' });
    try {
      const first = await h.registerUser(server.base, 'solo');
      assert.equal((await first.get('/api/settings/version')).body.isAdmin, false);
      assert.equal((await first.get('/api/settings/check-update')).status, 403);
      assert.equal((await first.post('/api/settings/update')).status, 403);
    } finally {
      await server.stop();
    }
  });
});

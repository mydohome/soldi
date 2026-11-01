'use strict';

// Crea un utente da riga di comando (utile quando la registrazione è disabilitata).
// Come login puoi usare un'email o un nome utente semplice (non inviamo mai email).
//   docker compose exec web npm run user:create
//   docker compose exec web npm run user:create -- mario 'password' 'Mario'
//   docker compose exec web npm run user:create -- mario@esempio.it 'password' 'Mario'

require('dotenv').config();
const { pool } = require('../db/pool');
const { createUser } = require('../auth/users');
const { ask } = require('./prompt');

(async () => {
  try {
    const scripted = process.argv.length > 2; // identificativo passato come argomento
    const email = process.argv[2] || (await ask('Email o nome utente: '));
    const password =
      process.argv[3] || (scripted ? '' : await ask('Password (min 8 caratteri): ', { silent: true }));
    const displayName = process.argv[4] || (scripted ? '' : await ask('Nome (facoltativo): '));

    const user = await createUser({ email, password, displayName: displayName || undefined });
    console.log(`\n✓ Utente creato: ${user.email} (id ${user.id})`);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

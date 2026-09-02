'use strict';

// Crea un utente da riga di comando (utile quando la registrazione è disabilitata).
//   docker compose exec web npm run user:create
//   docker compose exec web npm run user:create -- email@esempio.it 'password' 'Nome'

require('dotenv').config();
const { pool } = require('../db/pool');
const { createUser } = require('../auth/users');
const { ask } = require('./prompt');

(async () => {
  try {
    const scripted = process.argv.length > 2; // email passata come argomento
    const email = process.argv[2] || (await ask('Email: '));
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

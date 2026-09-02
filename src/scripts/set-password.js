'use strict';

// Reimposta la password di un utente esistente.
//   docker compose exec web npm run user:password
//   docker compose exec web npm run user:password -- email@esempio.it 'nuova-password'

require('dotenv').config();
const { pool } = require('../db/pool');
const { setPassword } = require('../auth/users');
const { ask } = require('./prompt');

(async () => {
  try {
    const scripted = process.argv.length > 2;
    const email = process.argv[2] || (await ask('Email: '));
    const password =
      process.argv[3] || (scripted ? '' : await ask('Nuova password (min 8 caratteri): ', { silent: true }));

    const user = await setPassword(email, password);
    if (!user) {
      console.error(`\n✗ Nessun utente con email ${email}`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ Password aggiornata per ${user.email} (id ${user.id})`);
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

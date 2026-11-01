'use strict';

// Crea un backup dei soli dati di UN utente (categorie, conti, spese fisse,
// voci previste, movimenti, risparmio, Telegram) — non tutto il database.
//   docker compose exec web npm run user:backup -- mario@esempio.it

require('dotenv').config();
const { pool, query } = require('../db/pool');
const { normalizeUsername } = require('../auth/users');
const { createUserBackup } = require('../backup/backup-core');

(async () => {
  try {
    const email = process.argv[2];
    if (!email) throw new Error('Uso: npm run user:backup -- <email o nome utente>');
    const mail = normalizeUsername(email);
    const { rows } = await query('SELECT id, email FROM users WHERE email = $1', [mail]);
    if (!rows[0]) throw new Error(`Nessun utente con email ${mail}`);

    const dir = await createUserBackup({ userId: rows[0].id, email: rows[0].email });
    console.log(`\n✓ Backup di ${rows[0].email} creato in ${dir}`);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

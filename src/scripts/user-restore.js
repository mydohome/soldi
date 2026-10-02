'use strict';

// Ripristina il backup personale di UN utente (creato con `npm run
// user:backup`). Sostituisce SOLO i dati di quell'utente — gli altri utenti
// non vengono toccati.
//   docker compose exec web npm run user:restore -- mario@esempio.it --latest
//   docker compose exec web npm run user:restore -- mario@esempio.it soldi-user-backup-3-mario-2026-01-05_03-00-00
// Un backup di un altro utente si ripristina solo con --force.

require('dotenv').config();
const { pool, query } = require('../db/pool');
const { normalizeUsername } = require('../auth/users');
const { confirm } = require('../backup/confirm');
const { resolveUserBackupDir, readManifest, assertBackupOwner, restoreUserBackup } = require('../backup/restore-user');

(async () => {
  try {
    // --force e --yes sono flag, non argomenti posizionali (--latest invece è il valore del secondo).
    const force = process.argv.includes('--force');
    const [email, dirArg] = process.argv.slice(2).filter((a) => a !== '--force' && a !== '--yes');
    if (!email) throw new Error('Uso: npm run user:restore -- <email o nome utente> [--latest|nome-cartella] [--force]');
    const mail = normalizeUsername(email);
    const { rows } = await query('SELECT id, email FROM users WHERE email = $1', [mail]);
    if (!rows[0]) throw new Error(`Nessun utente con email ${mail}`);
    const userId = rows[0].id;

    const dir = resolveUserBackupDir(userId, dirArg);
    assertBackupOwner(dir, userId, { force }); // prima della conferma
    const manifest = readManifest(dir);

    console.log(`\n[restore-user] utente: ${rows[0].email} (id ${userId})`);
    console.log(`[restore-user] sorgente: ${dir}`);
    if (manifest) {
      console.log(`[restore-user] creato: ${manifest.createdAt}`);
      for (const [name, info] of Object.entries(manifest.tables)) {
        console.log(`[restore-user]   ${name}: ${info.rows} righe`);
      }
    }
    console.log(`\n[restore-user] Questo SOSTITUISCE tutti i dati di ${rows[0].email}. Gli altri utenti non sono toccati.`);

    const ok = await confirm('Scrivi "yes" per continuare: ');
    if (!ok) {
      console.log('[restore-user] annullato');
      return;
    }

    const summary = await restoreUserBackup({ userId, dir, force });
    console.log(`\n✓ Dati di ${rows[0].email} ripristinati:`);
    for (const [name, count] of Object.entries(summary)) console.log(`    ${name}: ${count} righe`);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

'use strict';

// Menu interattivo per la gestione utenti: scegli o crea un utente, poi
// cambia password o configura Telegram, senza ricordare comandi e flag.
//   docker compose exec web npm run user:manage
//
// Per script/automazione restano disponibili i comandi singoli:
// user:create, user:password, user:telegram.

require('dotenv').config();
const { pool, query } = require('../db/pool');
const { createUser, setPassword } = require('../auth/users');
const { setTelegramConfig, getTelegramStatus, clearTelegramConfig } = require('../auth/telegram');
const { createUserBackup, listUserBackups } = require('../backup/backup-core');
const { resolveUserBackupDir, readManifest, restoreUserBackup } = require('../backup/restore-user');
const { ask } = require('./prompt');

async function listUsers() {
  const { rows } = await query('SELECT id, email, display_name FROM users ORDER BY id');
  return rows;
}

async function pickUser() {
  const users = await listUsers();
  console.log('\nUtenti:');
  if (users.length === 0) console.log('  (nessuno)');
  users.forEach((u, i) => console.log(`  ${i + 1}) ${u.email}${u.display_name ? ` (${u.display_name})` : ''}`));
  console.log('  n) Crea nuovo utente');
  console.log('  q) Esci');

  const choice = (await ask('\nScegli: ')).trim().toLowerCase();
  if (choice === 'q') return null;

  if (choice === 'n') {
    try {
      const email = await ask('Email o nome utente: ');
      const password = await ask('Password (min 8 caratteri): ', { silent: true });
      const displayName = await ask('Nome (facoltativo): ');
      const user = await createUser({ email, password, displayName: displayName || undefined });
      console.log(`\n✓ Utente creato: ${user.email} (id ${user.id})`);
      return { id: user.id, email: user.email };
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
      return pickUser();
    }
  }

  const idx = Number(choice) - 1;
  if (!Number.isInteger(idx) || !users[idx]) {
    console.log('Scelta non valida.');
    return pickUser();
  }
  return users[idx];
}

async function restoreMenu(user) {
  const backups = listUserBackups(user.id);
  if (backups.length === 0) {
    console.log('\nNessun backup personale trovato per questo utente.');
    return;
  }

  console.log('\nBackup disponibili (dal più vecchio al più recente):');
  backups.forEach((name, i) => console.log(`  ${i + 1}) ${name}`));
  const pick = (await ask('Numero (invio = più recente): ')).trim();
  const dirName = pick ? backups[Number(pick) - 1] : backups[backups.length - 1];
  if (!dirName) {
    console.log('Scelta non valida.');
    return;
  }

  const dir = resolveUserBackupDir(user.id, dirName);
  const manifest = readManifest(dir);
  if (manifest) {
    for (const [name, info] of Object.entries(manifest.tables)) console.log(`  ${name}: ${info.rows} righe`);
  }
  console.log(`\nQuesto SOSTITUISCE tutti i dati di ${user.email}. Gli altri utenti non sono toccati.`);

  const confirmed = (await ask('Confermi? (scrivi yes): ')).trim().toLowerCase() === 'yes';
  if (!confirmed) {
    console.log('Annullato.');
    return;
  }

  const summary = await restoreUserBackup({ userId: user.id, dir });
  console.log('\n✓ Ripristinato:');
  for (const [name, count] of Object.entries(summary)) console.log(`    ${name}: ${count} righe`);
}

/** Ritorna 'quit' o 'back' quando l'utente esce dal sotto-menu. */
async function userMenu(user) {
  for (;;) {
    console.log(`\n— ${user.email} —`);
    console.log('  1) Cambia password');
    console.log('  2) Configura Telegram (bot token + chat id)');
    console.log('  3) Stato Telegram');
    console.log('  4) Rimuovi configurazione Telegram');
    console.log('  5) Crea backup personale (solo i dati di questo utente)');
    console.log('  6) Ripristina da un backup personale');
    console.log('  b) Torna alla lista utenti');
    console.log('  q) Esci');

    const choice = (await ask('\nScegli: ')).trim().toLowerCase();
    if (choice === 'q') return 'quit';
    if (choice === 'b') return 'back';

    try {
      if (choice === '1') {
        const password = await ask('Nuova password (min 8 caratteri): ', { silent: true });
        const updated = await setPassword(user.email, password);
        console.log(`\n✓ Password aggiornata per ${updated.email}`);
      } else if (choice === '2') {
        const botToken = await ask('Bot token: ', { silent: true });
        const chatId = await ask('Chat ID: ');
        const saved = await setTelegramConfig(user.email, { botToken, chatId });
        console.log(`\n✓ Configurazione Telegram salvata (chat ${saved.chatIdMasked})`);
      } else if (choice === '3') {
        const status = await getTelegramStatus(user.email);
        console.log(
          status.configured ? `\nTelegram configurato — chat ${status.chatIdMasked}` : '\nTelegram non configurato.'
        );
      } else if (choice === '4') {
        const result = await clearTelegramConfig(user.email);
        console.log(
          result.removed ? '\n✓ Configurazione Telegram rimossa.' : '\nNessuna configurazione da rimuovere.'
        );
      } else if (choice === '5') {
        const dir = await createUserBackup({ userId: user.id, email: user.email });
        console.log(`\n✓ Backup creato in ${dir}`);
      } else if (choice === '6') {
        await restoreMenu(user);
      } else {
        console.log('Scelta non valida.');
      }
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
    }
  }
}

(async () => {
  try {
    for (;;) {
      const user = await pickUser();
      if (!user) break;
      const result = await userMenu(user);
      if (result === 'quit') break;
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
    console.log('\nCiao!');
  }
})();

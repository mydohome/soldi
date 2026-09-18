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
      const email = await ask('Email: ');
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

/** Ritorna 'quit' o 'back' quando l'utente esce dal sotto-menu. */
async function userMenu(user) {
  for (;;) {
    console.log(`\n— ${user.email} —`);
    console.log('  1) Cambia password');
    console.log('  2) Configura Telegram (bot token + chat id)');
    console.log('  3) Stato Telegram');
    console.log('  4) Rimuovi configurazione Telegram');
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

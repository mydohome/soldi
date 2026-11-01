'use strict';

// Configura, mostra o rimuove l'integrazione Telegram di un utente (bot token
// + chat id). Salvati cifrati nel database (vedi src/crypto/secrets.js,
// richiede SECRETS_KEY nel .env) e gestiti SOLO da qui: nessuna rotta HTTP
// legge o scrive queste credenziali.
//
//   docker compose exec web npm run user:telegram -- mario@esempio.it set '<bot_token>' '<chat_id>'
//   docker compose exec web npm run user:telegram -- mario@esempio.it show
//   docker compose exec web npm run user:telegram -- mario@esempio.it remove
//
// Senza argomenti dopo l'email/nome utente chiede tutto a prompt.

require('dotenv').config();
const { pool } = require('../db/pool');
const { setTelegramConfig, getTelegramStatus, clearTelegramConfig } = require('../auth/telegram');
const { ask } = require('./prompt');

(async () => {
  try {
    const email = process.argv[2] || (await ask('Email o nome utente: '));
    const action = (process.argv[3] || (await ask('Azione (set/show/remove): '))).trim().toLowerCase();

    if (action === 'set') {
      const botToken = process.argv[4] || (await ask('Bot token: ', { silent: true }));
      const chatId = process.argv[5] || (await ask('Chat ID: '));
      const user = await setTelegramConfig(email, { botToken, chatId });
      console.log(`\n✓ Configurazione Telegram salvata per ${user.email} (chat ${user.chatIdMasked})`);
    } else if (action === 'show') {
      const status = await getTelegramStatus(email);
      if (!status.configured) {
        console.log(`\n${status.email}: Telegram non configurato.`);
      } else {
        const updated = new Date(status.updatedAt).toISOString().slice(0, 19).replace('T', ' ');
        console.log(`\n${status.email}: configurato — chat ${status.chatIdMasked} (aggiornato ${updated})`);
      }
    } else if (action === 'remove') {
      const user = await clearTelegramConfig(email);
      console.log(
        user.removed
          ? `\n✓ Configurazione Telegram rimossa per ${user.email}`
          : `\n${user.email}: nessuna configurazione Telegram da rimuovere.`
      );
    } else {
      throw new Error(`Azione sconosciuta "${action}" — usa set, show o remove`);
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

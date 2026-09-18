'use strict';

const { query } = require('../db/pool');
const { encrypt, decrypt } = require('../crypto/secrets');
const { normalizeEmail } = require('./users');

/** Mostra solo le ultime 4 cifre/caratteri, mai il valore intero. */
function mask(value) {
  const s = String(value || '');
  return s.length <= 4 ? '*'.repeat(s.length) : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

async function findUser(email) {
  const mail = normalizeEmail(email);
  const { rows } = await query('SELECT id, email FROM users WHERE email = $1', [mail]);
  if (!rows[0]) {
    const err = new Error(`Nessun utente con email ${mail}`);
    err.code = 'user_not_found';
    throw err;
  }
  return rows[0];
}

/**
 * Salva (o sostituisce) bot token + chat id di un utente, cifrati a riposo.
 * Usata solo dalla CLI (`npm run user:telegram`) — nessuna rotta HTTP la espone.
 */
async function setTelegramConfig(email, { botToken, chatId }) {
  const user = await findUser(email);
  const token = String(botToken || '').trim();
  const chat = String(chatId || '').trim();
  if (!token || !chat) {
    const err = new Error('Bot token e chat id sono entrambi obbligatori');
    err.code = 'bad_input';
    throw err;
  }
  await query(
    `INSERT INTO telegram_settings (user_id, bot_token_enc, chat_id_enc, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET bot_token_enc = EXCLUDED.bot_token_enc,
           chat_id_enc = EXCLUDED.chat_id_enc,
           updated_at = now()`,
    [user.id, encrypt(token), encrypt(chat)]
  );
  return { ...user, chatIdMasked: mask(chat) };
}

/** Stato per la CLI: non ritorna mai il token in chiaro. */
async function getTelegramStatus(email) {
  const user = await findUser(email);
  const { rows } = await query(
    'SELECT chat_id_enc, updated_at FROM telegram_settings WHERE user_id = $1',
    [user.id]
  );
  if (!rows[0]) return { ...user, configured: false };
  return {
    ...user,
    configured: true,
    chatIdMasked: mask(decrypt(rows[0].chat_id_enc)),
    updatedAt: rows[0].updated_at,
  };
}

/** Rimuove la configurazione Telegram di un utente. */
async function clearTelegramConfig(email) {
  const user = await findUser(email);
  const { rowCount } = await query('DELETE FROM telegram_settings WHERE user_id = $1', [user.id]);
  return { ...user, removed: rowCount > 0 };
}

/**
 * Credenziali in chiaro per uso **interno lato server** (es. invio di un
 * backup). Non esporre mai il risultato via HTTP o log.
 */
async function getTelegramCredentials(userId) {
  const { rows } = await query(
    'SELECT bot_token_enc, chat_id_enc FROM telegram_settings WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return null;
  return { botToken: decrypt(rows[0].bot_token_enc), chatId: decrypt(rows[0].chat_id_enc) };
}

module.exports = {
  setTelegramConfig,
  getTelegramStatus,
  clearTelegramConfig,
  getTelegramCredentials,
  mask,
};

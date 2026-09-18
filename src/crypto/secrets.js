'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// SECRETS_KEY cifra i dati sensibili salvati nel database (oggi: le
// credenziali Telegram) in modo che un dump/leak del solo database non basti
// a leggerli in chiaro — serve anche questa chiave, che vive solo nel .env
// dell'host. Genera con: openssl rand -hex 32
function loadKey() {
  const hex = process.env.SECRETS_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    const err = new Error(
      'SECRETS_KEY mancante o non valida nel .env: deve essere una stringa esadecimale di 64 ' +
        'caratteri (32 byte). Generala con: openssl rand -hex 32'
    );
    err.code = 'bad_secrets_key';
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

/** Cifra una stringa. Ritorna "iv:authTag:ciphertext" (tutto esadecimale). */
function encrypt(plaintext) {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Decifra un valore prodotto da encrypt(). */
function decrypt(payload) {
  const key = loadKey();
  const [ivHex, tagHex, dataHex] = String(payload || '').split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Valore cifrato non valido o corrotto');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };

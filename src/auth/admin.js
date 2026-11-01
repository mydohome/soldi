'use strict';

const { query } = require('../db/pool');

/**
 * Amministratore dell'installazione: l'utente con email ADMIN_EMAIL se è
 * impostata, altrimenti il primo utente creato (id più basso). Se ADMIN_EMAIL
 * non corrisponde a nessun utente non c'è alcun amministratore: si chiude,
 * non si apre. Serve a proteggere le operazioni che riguardano tutta
 * l'installazione (aggiornamento e riavvio), non i dati di un singolo utente.
 */
async function isAdmin(userId) {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail) {
    const r = await query('SELECT 1 FROM users WHERE id = $1 AND email = $2', [userId, adminEmail]);
    return r.rowCount > 0;
  }
  const r = await query('SELECT id FROM users ORDER BY id LIMIT 1');
  return r.rowCount > 0 && String(r.rows[0].id) === String(userId);
}

/** Da usare dopo requireAuth. */
async function requireAdmin(req, res, next) {
  try {
    if (await isAdmin(req.user.id)) return next();
    return res.status(403).json({
      error: 'admin_only',
      message: 'Solo l’amministratore può eseguire questa operazione',
    });
  } catch (err) {
    console.error('[admin] controllo amministratore non riuscito', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = { isAdmin, requireAdmin };

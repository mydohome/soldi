'use strict';

// Elenca gli utenti.
//   docker compose exec web npm run user:list

require('dotenv').config();
const { pool, query } = require('../db/pool');

(async () => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.display_name, u.created_at,
              (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id)::int AS movimenti
       FROM users u ORDER BY u.id`
    );
    if (rows.length === 0) {
      console.log('Nessun utente.');
    } else {
      for (const r of rows) {
        const created = new Date(r.created_at).toISOString().slice(0, 10);
        console.log(
          `#${r.id}  ${r.email.padEnd(30)}  ${(r.display_name || '').padEnd(16)}  ${created}  ${r.movimenti} movimenti`
        );
      }
    }
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

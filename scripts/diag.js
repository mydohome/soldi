'use strict';

// Diagnostica di Soldi (sola lettura). Uso:
//   docker compose exec web npm run diag                 # testo
//   docker compose exec web npm run diag -- --json       # JSON
//   npm run diag -- --data-only                          # solo schema e dati (ignora configurazione e backup)
// Il database è quello delle variabili PG* (o DATABASE_URL), come per l'app: ops/restore-test.sh
// la lancia sul database temporaneo. Uscita: 0 ok, 2 avvisi, 1 errori. Mai segreti o dati personali.

require('dotenv').config();
const { pool } = require('../src/db/pool');
const { runDiagnostics } = require('../src/diag/checks');

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('Uso: npm run diag -- [--json] [--data-only]');
  process.exit(0);
}

const LABEL = { ok: 'OK    ', warn: 'AVVISO', error: 'ERRORE' };
const fmtBytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`);

(async () => {
  try {
    const result = await runDiagnostics({ pool, dataOnly: args.has('--data-only') });
    if (args.has('--json')) {
      console.log(JSON.stringify(result));
    } else {
      console.log('Soldi — diagnostica');
      let group = '';
      for (const c of result.checks) {
        if (c.group !== group) { group = c.group; console.log(`\n[${group}]`); }
        console.log(`  ${LABEL[c.level]}  ${c.message}`);
      }
      const i = result.info;
      console.log(`\nInformazioni: PostgreSQL ${i.postgres} · database ${fmtBytes(i.databaseBytes)} · app ${i.appSha}`);
      console.log(`  righe: ${Object.entries(i.rows).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
      console.log(`\nEsito: ${result.summary.ok} ok, ${result.summary.warn} avvisi, ${result.summary.error} errori`);
    }
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error(`Diagnostica non riuscita: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

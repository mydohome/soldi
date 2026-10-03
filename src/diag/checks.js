'use strict';

// Diagnostica di Soldi: controlli in SOLA LETTURA (transazione READ ONLY) su schema, dati,
// configurazione e backup. Non stampa mai segreti né dati personali: solo conteggi e nomi
// di tabelle/vincoli. Usata da `npm run diag` (scripts/diag.js) e da ops/restore-test.sh.

const fs = require('fs');
const path = require('path');

const TABLES = require('../backup/tables');
const { decrypt } = require('../crypto/secrets');
const { scheduleEndMonth, monthStart } = require('../recurring/schedule');

const EXPECTED_INDEXES = [
  'uq_tx_rule_month',
  'idx_tx_user_date',
  'idx_tx_user_category',
  'idx_tx_user_account',
  'idx_tx_user_scope',
  'idx_cat_user',
  'idx_acc_user',
  'idx_rec_user',
  'idx_planned_user',
];
const EXPECTED_CONSTRAINTS = [
  'transactions_scope_check',
  'categories_scope_check',
  'categories_user_id_name_kind_scope_key',
  'recurring_rules_cadence_check',
  'recurring_rules_month_check',
  'recurring_rules_total_occ_check',
  'recurring_yearly_month_check',
  'planned_yearly_month_check',
];
const IDENTITY_TABLES = ['users', 'categories', 'accounts', 'recurring_rules', 'planned_expenses', 'transactions'];
const DEFAULT_JWT = /^change-me/i;

async function runDiagnostics({ pool, env = process.env, dataOnly = false, now = new Date() }) {
  const checks = [];
  const info = {};
  const add = (id, group, level, message, count) => checks.push({ id, group, level, message, ...(count != null ? { count } : {}) });
  const count = async (client, sql, params = []) => (await client.query(sql, params)).rows[0].n;
  const names = (rows, col) => rows.map((r) => r[col]).join(', ');

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    // ------------------------------------------------------------------ schema
    const tablesInDb = new Set((await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name));
    const missingTables = TABLES.map((t) => t.name).filter((n) => !tablesInDb.has(n));
    if (missingTables.length) add('schema_tables', 'schema', 'error', `tabelle mancanti: ${missingTables.join(', ')}`, missingTables.length);
    else add('schema_tables', 'schema', 'ok', `tabelle presenti (${TABLES.length})`);

    const cols = await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const have = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missingCols = [];
    for (const t of TABLES) for (const c of t.columns) if (tablesInDb.has(t.name) && !have.has(`${t.name}.${c}`)) missingCols.push(`${t.name}.${c}`);
    if (missingCols.length) add('schema_columns', 'schema', 'error', `colonne mancanti: ${missingCols.join(', ')}`, missingCols.length);
    else add('schema_columns', 'schema', 'ok', 'colonne attese presenti');

    const idx = new Set((await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname));
    const missingIdx = EXPECTED_INDEXES.filter((n) => !idx.has(n));
    if (missingIdx.length) add('schema_indexes', 'schema', 'error', `indici mancanti: ${missingIdx.join(', ')}`, missingIdx.length);
    else add('schema_indexes', 'schema', 'ok', `indici attesi presenti (${EXPECTED_INDEXES.length}, incluso uq_tx_rule_month)`);

    const cons = (await client.query(`SELECT conname, convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'`)).rows;
    const consSet = new Set(cons.map((r) => r.conname));
    const missingCons = EXPECTED_CONSTRAINTS.filter((n) => !consSet.has(n));
    if (missingCons.length) add('schema_constraints', 'schema', 'error', `vincoli mancanti: ${missingCons.join(', ')}`, missingCons.length);
    else add('schema_constraints', 'schema', 'ok', `vincoli attesi presenti (${EXPECTED_CONSTRAINTS.length})`);
    // I due vincoli «annuale ⇒ mese» nascono NOT VALID (additivi: i dati storici non bloccano l'avvio).
    // Sono un avviso solo se esistono righe che li violano; senza violazioni sono convalidabili.
    const notValid = cons.filter((r) => !r.convalidated);
    if (notValid.length) {
      const violations = {};
      if (tablesInDb.has('recurring_rules')) violations.recurring_yearly_month_check = await count(client, `SELECT count(*)::int AS n FROM recurring_rules WHERE cadence = 'yearly' AND month IS NULL`);
      if (tablesInDb.has('planned_expenses')) violations.planned_yearly_month_check = await count(client, `SELECT count(*)::int AS n FROM planned_expenses WHERE cadence = 'yearly' AND month IS NULL`);
      const offending = notValid.filter((r) => violations[r.conname] !== 0); // sconosciuti o con righe fuori regola
      const list = names(notValid, 'conname');
      if (offending.length) add('schema_not_valid', 'schema', 'warn', `vincoli presenti ma NOT VALID, con righe che li violano o non verificabili: ${names(offending, 'conname')}`, offending.length);
      else add('schema_not_valid', 'schema', 'ok', `vincoli NOT VALID senza righe fuori regola (${list}): convalidabili con ALTER TABLE … VALIDATE CONSTRAINT …`);
    } else add('schema_not_valid', 'schema', 'ok', 'tutti i vincoli sono convalidati');

    // ------------------------------------------------------------------ dati
    if (tablesInDb.has('recurring_rules') && tablesInDb.has('planned_expenses')) {
      const yr = await count(client, `SELECT count(*)::int AS n FROM recurring_rules WHERE cadence = 'yearly' AND month IS NULL`);
      const yp = await count(client, `SELECT count(*)::int AS n FROM planned_expenses WHERE cadence = 'yearly' AND month IS NULL`);
      if (yr + yp) add('yearly_without_month', 'dati', 'warn', `voci annuali senza mese: ${yr} spese fisse (non generano nulla), ${yp} voci previste`, yr + yp);
      else add('yearly_without_month', 'dati', 'ok', 'nessuna voce annuale senza mese');
    }

    if (tablesInDb.has('transactions') && tablesInDb.has('categories')) {
      const kt = await count(client, `SELECT count(*)::int AS n FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.kind <> t.type`);
      const kr = await count(client, `SELECT count(*)::int AS n FROM recurring_rules r JOIN categories c ON c.id = r.category_id WHERE c.kind <> r.type`);
      if (kt + kr) add('kind_mismatch', 'dati', 'warn', `categoria di tipo diverso dal movimento: ${kt} movimenti, ${kr} spese fisse`, kt + kr);
      else add('kind_mismatch', 'dati', 'ok', 'tipo di categoria coerente con movimenti e spese fisse');

      // isolamento: un utente non deve mai puntare a categorie o conti di un altro
      const cross = {
        movimenti: await count(client, `SELECT count(*)::int AS n FROM transactions t WHERE
          EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category_id AND c.user_id <> t.user_id)
          OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.user_id <> t.user_id)`),
        'spese fisse': await count(client, `SELECT count(*)::int AS n FROM recurring_rules r WHERE
          EXISTS (SELECT 1 FROM categories c WHERE c.id = r.category_id AND c.user_id <> r.user_id)
          OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = r.account_id AND a.user_id <> r.user_id)`),
        'voci previste': await count(client, `SELECT count(*)::int AS n FROM planned_expenses p WHERE
          EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.user_id <> p.user_id)`),
      };
      const total = Object.values(cross).reduce((a, b) => a + b, 0);
      if (total) {
        const detail = Object.entries(cross).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
        add('cross_user_refs', 'dati', 'error', `RIFERIMENTI TRA UTENTI DIVERSI (violazione di isolamento): ${detail}`, total);
      } else add('cross_user_refs', 'dati', 'ok', 'nessun riferimento tra utenti diversi');
    }

    if (tablesInDb.has('recurring_rules')) {
      const cur = monthStart(now);
      const stale = await count(client, `SELECT count(*)::int AS n FROM recurring_rules
        WHERE active = true AND NOT (cadence = 'yearly' AND month IS NULL)
          AND ((last_run_month IS NOT NULL AND last_run_month < ($1::date - interval '1 month'))
            OR (last_run_month IS NULL AND start_month < ($1::date - interval '1 month')))`, [cur]);
      if (stale) add('recurring_stale', 'dati', 'warn', `spese fisse attive in ritardo di più di un mese (cron fermo?): ${stale}`, stale);
      else add('recurring_stale', 'dati', 'ok', 'spese fisse attive aggiornate');

      const limited = (await client.query(`SELECT id, cadence, month, total_occurrences, start_month FROM recurring_rules
        WHERE active = true AND total_occurrences IS NOT NULL AND NOT (cadence = 'yearly' AND month IS NULL)`)).rows;
      const overdue = limited.filter((r) => scheduleEndMonth(r, r.start_month) < cur).length;
      if (overdue) add('recurring_overdue', 'dati', 'warn', `spese fisse a durata limitata ancora attive oltre la fine del piano: ${overdue}`, overdue);
      else add('recurring_overdue', 'dati', 'ok', 'nessuna spesa fissa attiva oltre la fine del piano');

      const excess = await count(client, `SELECT count(*)::int AS n FROM recurring_rules r WHERE r.total_occurrences IS NOT NULL
        AND (SELECT count(*) FROM transactions t WHERE t.recurring_rule_id = r.id) > r.total_occurrences`);
      if (excess) add('recurring_excess', 'dati', 'warn', `spese fisse con più movimenti generati del totale previsto: ${excess}`, excess);
      else add('recurring_excess', 'dati', 'ok', 'movimenti generati entro il totale previsto');
    }

    // sequenze IDENTITY (tipico dopo un ripristino): indietro rispetto a MAX(id) → errore al prossimo INSERT
    const behind = [];
    for (const table of IDENTITY_TABLES) {
      if (!tablesInDb.has(table)) continue;
      const r = await client.query(
        `SELECT COALESCE((SELECT s.last_value FROM pg_sequences s WHERE s.schemaname = 'public'
                           AND s.sequencename = split_part(pg_get_serial_sequence($1, 'id'), '.', 2)), 0)::bigint AS last,
                COALESCE((SELECT max(id) FROM ${table}), 0)::bigint AS max`,
        [`public.${table}`]
      );
      if (BigInt(r.rows[0].last) < BigInt(r.rows[0].max)) behind.push(table);
    }
    if (behind.length) add('identity_sequences', 'dati', 'error', `sequenze IDENTITY indietro rispetto a MAX(id): ${behind.join(', ')} (il prossimo inserimento fallirebbe)`, behind.length);
    else add('identity_sequences', 'dati', 'ok', 'sequenze IDENTITY allineate');

    if (tablesInDb.has('users')) {
      const dup = await count(client, `SELECT count(*)::int AS n FROM (SELECT lower(email) FROM users GROUP BY 1 HAVING count(*) > 1) d`);
      if (dup) add('users_duplicate_email', 'dati', 'error', `utenti con lo stesso identificativo a meno delle maiuscole: ${dup} gruppi`, dup);
      else add('users_duplicate_email', 'dati', 'ok', 'nessun identificativo utente duplicato');
    }

    if (tablesInDb.has('telegram_settings')) {
      const rows = (await client.query('SELECT bot_token_enc, chat_id_enc FROM telegram_settings')).rows;
      if (rows.length === 0) add('telegram_decrypt', 'dati', 'ok', 'nessuna configurazione Telegram salvata');
      else {
        let bad = 0;
        for (const r of rows) {
          try {
            decrypt(r.bot_token_enc);
            decrypt(r.chat_id_enc);
          } catch {
            bad += 1;
          }
        }
        if (bad) add('telegram_decrypt', 'dati', 'error', `credenziali Telegram NON decifrabili con la SECRETS_KEY corrente: ${bad} su ${rows.length} (chiave diversa dopo un ripristino?)`, bad);
        else add('telegram_decrypt', 'dati', 'ok', `credenziali Telegram decifrabili (${rows.length})`);
      }
    }

    // ------------------------------------------------------------------ configurazione e backup
    if (!dataOnly) {
      const jwt = env.JWT_SECRET || '';
      if (!jwt) add('config_jwt', 'config', 'error', 'JWT_SECRET assente');
      else if (DEFAULT_JWT.test(jwt)) add('config_jwt', 'config', 'error', 'JWT_SECRET è ancora il valore di esempio');
      else if (jwt.length < 32) add('config_jwt', 'config', 'warn', `JWT_SECRET corto (${jwt.length} caratteri, meglio ≥ 32: openssl rand -hex 32)`);
      else add('config_jwt', 'config', 'ok', 'JWT_SECRET impostato');

      const sk = env.SECRETS_KEY || '';
      if (!sk) add('config_secrets_key', 'config', 'warn', 'SECRETS_KEY assente (serve per le credenziali Telegram cifrate)');
      else if (!/^[0-9a-f]{64}$/i.test(sk)) add('config_secrets_key', 'config', 'error', 'SECRETS_KEY non valida (servono 64 caratteri esadecimali)');
      else add('config_secrets_key', 'config', 'ok', 'SECRETS_KEY valida');

      if ((env.PGPASSWORD || '') === 'soldi') add('config_pgpassword', 'config', 'warn', 'PGPASSWORD è quella predefinita («soldi»)');
      else add('config_pgpassword', 'config', 'ok', 'PGPASSWORD personalizzata');

      if (String(env.ALLOW_REGISTRATION).toLowerCase() === 'true') add('config_registration', 'config', 'warn', 'ALLOW_REGISTRATION=true: chiunque raggiunga l’app può registrarsi (disattivala dopo aver creato gli utenti)');
      else add('config_registration', 'config', 'ok', 'registrazione pubblica disattivata');

      if (String(env.HTTPS_ENABLED).toLowerCase() === 'true' && String(env.COOKIE_SECURE).toLowerCase() === 'false') {
        add('config_cookie', 'config', 'warn', 'HTTPS_ENABLED=true ma COOKIE_SECURE=false: il cookie di sessione non è marcato Secure');
      } else add('config_cookie', 'config', 'ok', 'cookie di sessione coerente con HTTPS');

      const dir = env.BACKUP_DIR || '/app/backups';
      try {
        const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('soldi-backup-'));
        let newest = 0;
        for (const d of dirs) {
          try { newest = Math.max(newest, fs.statSync(path.join(dir, d.name, 'manifest.json')).mtimeMs); } catch { /* manifest assente */ }
        }
        if (!newest) add('backup_age', 'backup', 'warn', 'nessun backup applicativo trovato nella cartella dei backup');
        else {
          const days = Math.floor((now.getTime() - newest) / 86400000);
          if (days > 8) add('backup_age', 'backup', 'warn', `l'ultimo backup applicativo ha ${days} giorni`, days);
          else add('backup_age', 'backup', 'ok', `ultimo backup applicativo di ${days} giorni fa`);
        }
      } catch {
        add('backup_age', 'backup', 'warn', 'cartella dei backup non accessibile da qui');
      }
    }

    // ------------------------------------------------------------------ informazioni
    info.postgres = ((await client.query('SHOW server_version')).rows[0].server_version || '').split(' ')[0];
    const size = (await client.query('SELECT pg_database_size(current_database())::bigint AS b')).rows[0].b;
    info.databaseBytes = Number(size);
    info.rows = {};
    for (const t of TABLES) {
      if (tablesInDb.has(t.name)) info.rows[t.name] = await count(client, `SELECT count(*)::int AS n FROM ${t.name}`);
    }
    info.appSha = (env.GIT_SHA || '').slice(0, 7) || 'sconosciuta';
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const c of checks) summary[c.level] += 1;
  const exitCode = summary.error ? 1 : summary.warn ? 2 : 0;
  return { version: 1, ok: exitCode === 0, exitCode, summary, checks, info };
}

module.exports = { runDiagnostics, EXPECTED_INDEXES, EXPECTED_CONSTRAINTS };

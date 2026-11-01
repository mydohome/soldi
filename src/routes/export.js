'use strict';

// Esportazione dei movimenti dell'utente (Excel/CSV), nel rispetto dei filtri
// della vista "Movimenti". Le righe vengono lette dal database a lotti e scritte
// direttamente nella risposta: la memoria non dipende dal numero di movimenti.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const { query } = require('../db/pool');
const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');
const { filterFields, buildTxFilter } = require('../transactions/filters');

const router = express.Router();
router.use(requireAuth);

// L'export è la rotta più pesante dell'app: pochi per minuto per utente.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => Number(process.env.EXPORT_RATE_MAX) || 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  message: { error: 'too_many_requests', message: 'Troppe esportazioni in poco tempo. Riprova tra un minuto.' },
});

// Letti a ogni richiesta (non all'avvio) per poterli ridurre nei test.
const maxRows = () => Number(process.env.EXPORT_MAX_ROWS) || 50_000;
const batchSize = () => Number(process.env.EXPORT_BATCH_SIZE) || 2_000;

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_CSV = 'text/csv; charset=utf-8';

const exportQuery = z.object({ ...filterFields, format: z.enum(['xlsx', 'csv']).default('xlsx') });

// Nomi stabili: serviranno a un futuro import, non rinominarli.
const COLUMNS = ['Data', 'Tipo', 'Importo', 'Categoria', 'Conto', 'Ambito', 'Nota', 'Netto', 'Spesa fissa'];
const TYPE_LABEL = { expense: 'Spesa', income: 'Entrata' };
const SCOPE_LABEL = { personal: 'Personale', home: 'Casa' };

const FROM_SQL = `
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN accounts   a ON a.id = t.account_id
  LEFT JOIN recurring_rules r ON r.id = t.recurring_rule_id`;

// Lotti per chiave (occurred_on, id) decrescente: l'ordine del file è quello
// richiesto (data decrescente) e ogni lotto parte dall'ultima riga del precedente,
// senza OFFSET né risultati in memoria.
async function* readBatches(where, params) {
  const size = batchSize();
  let cursor = null;
  for (;;) {
    const p = [...params];
    const w = [...where];
    if (cursor) {
      p.push(cursor.occurredOn, cursor.id);
      w.push(`(t.occurred_on, t.id) < ($${p.length - 1}, $${p.length})`);
    }
    p.push(size);
    const { rows } = await query(
      `SELECT t.id, t.occurred_on, t.type, t.amount_cents, t.scope, t.note,
              c.name AS category, a.name AS account, r.name AS rule
       ${FROM_SQL}
       WHERE ${w.join(' AND ')}
       ORDER BY t.occurred_on DESC, t.id DESC
       LIMIT $${p.length}`,
      p
    );
    if (rows.length === 0) return;
    yield rows;
    const last = rows[rows.length - 1];
    cursor = { occurredOn: last.occurred_on, id: last.id };
    if (rows.length < size) return;
  }
}

// DATE arriva come 'YYYY-MM-DD' (pool.js): Date UTC, per non slittare col fuso.
const excelDate = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const itDate = (s) => String(s).split('-').reverse().join('/');
const signedCents = (r) => (r.type === 'income' ? 1 : -1) * Number(r.amount_cents);

// CSV: importi con la virgola decimale, in centesimi interi.
const itAmount = (cents) => {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
};

// Una cella di testo che inizia con = + - @ tab o ritorno a capo verrebbe
// valutata come formula da Excel/LibreOffice: l'apice la rende testo. Solo per il
// CSV: nel .xlsx le stringhe restano stringhe e non si alterano i dati.
const neutralizeFormula = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const csvCell = (s) => (/[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvText = (v) => csvCell(neutralizeFormula(v == null ? '' : String(v)));

function csvLine(r) {
  const cents = Number(r.amount_cents);
  return [
    itDate(r.occurred_on),
    TYPE_LABEL[r.type],
    itAmount(cents),
    csvText(r.category),
    csvText(r.account),
    SCOPE_LABEL[r.scope],
    csvText(r.note),
    itAmount(signedCents(r)),
    csvText(r.rule),
  ].join(';');
}

async function writeCsv(res, where, params) {
  const write = (chunk) => (res.write(chunk) ? null : new Promise((ok) => res.once('drain', ok)));
  await write('﻿' + COLUMNS.join(';') + '\r\n');
  for await (const rows of readBatches(where, params)) {
    await write(rows.map((r) => csvLine(r) + '\r\n').join(''));
  }
  res.end();
}

async function writeXlsx(ExcelJS, res, where, params, info) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  wb.creator = 'Soldi';
  const ws = wb.addWorksheet('Movimenti', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Data', key: 'date', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Tipo', key: 'type', width: 10 },
    { header: 'Importo', key: 'amount', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Categoria', key: 'category', width: 22 },
    { header: 'Conto', key: 'account', width: 20 },
    { header: 'Ambito', key: 'scope', width: 11 },
    { header: 'Nota', key: 'note', width: 40 },
    { header: 'Netto', key: 'net', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Spesa fissa', key: 'rule', width: 24 },
  ];
  ws.autoFilter = `A1:I${Math.max(info.count, 1) + 1}`;
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.commit();

  for await (const rows of readBatches(where, params)) {
    for (const r of rows) {
      ws.addRow({
        date: excelDate(r.occurred_on),
        type: TYPE_LABEL[r.type],
        amount: Number(r.amount_cents) / 100,
        category: r.category || null,
        account: r.account || null,
        scope: SCOPE_LABEL[r.scope],
        note: r.note || null,
        net: signedCents(r) / 100,
        rule: r.rule || null,
      }).commit();
    }
  }
  ws.commit();

  const meta = wb.addWorksheet('Info');
  meta.columns = [{ width: 24 }, { width: 50 }];
  for (const [k, v] of info.rows) {
    const row = meta.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.commit();
  }
  meta.commit();
  await wb.commit();
}

// Filtri applicati, in chiaro, per il foglio "Info". I nomi di categoria e conto
// si cercano sempre con user_id: l'id di un altro utente non rivela nulla.
async function describeFilters(userId, q) {
  const lines = [];
  lines.push(['Periodo', q.from || q.to ? `${q.from ? itDate(q.from) : 'inizio'} – ${q.to ? itDate(q.to) : 'oggi'}` : 'Tutti i movimenti']);
  if (q.type) lines.push(['Tipo', TYPE_LABEL[q.type]]);
  if (q.scope) lines.push(['Ambito', SCOPE_LABEL[q.scope]]);
  for (const [key, table, label] of [['categoryId', 'categories', 'Categoria'], ['accountId', 'accounts', 'Conto']]) {
    if (!q[key]) continue;
    const r = await query(`SELECT name FROM ${table} WHERE id = $1 AND user_id = $2`, [q[key], userId]);
    lines.push([label, r.rows[0]?.name || '(non trovata)']);
  }
  if (q.q) lines.push(['Ricerca', q.q]);
  return lines;
}

router.get(
  '/transactions',
  exportLimiter,
  handler(async (req, res) => {
    const q = exportQuery.parse(req.query);
    const { where, params } = buildTxFilter(req.user.id, q);

    // exceljs si carica qui e non in cima al file: un aggiornamento in-app (git pull
    // + riavvio) non reinstalla node_modules, e l'app deve avviarsi comunque.
    let ExcelJS = null;
    if (q.format === 'xlsx') {
      try {
        ExcelJS = require('exceljs');
      } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') throw err;
        throw httpError(
          503,
          'xlsx_unavailable',
          'Esportazione Excel non disponibile finché l’immagine non viene ricostruita (esegui ./update.sh). Puoi esportare in CSV.'
        );
      }
    }

    const counted = await query(`SELECT COUNT(*)::int AS n ${FROM_SQL} WHERE ${where.join(' AND ')}`, params);
    const count = counted.rows[0].n;
    if (count > maxRows()) throw httpError(400, 'too_many_rows', 'Troppi movimenti: restringi il periodo');

    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, fuso del server
    res.set({
      'Content-Type': q.format === 'csv' ? MIME_CSV : MIME_XLSX,
      'Content-Disposition': `attachment; filename="soldi-movimenti-${today}.${q.format}"`,
      'Cache-Control': 'no-store',
    });

    try {
      if (q.format === 'csv') return await writeCsv(res, where, params);
      const user = await query('SELECT display_name FROM users WHERE id = $1', [req.user.id]);
      const info = {
        count,
        rows: [
          ['Esportato il', new Date().toLocaleString('it-IT')],
          ...(await describeFilters(req.user.id, q)),
          ['Movimenti esportati', count],
          ['Utente', user.rows[0]?.display_name || ''],
        ],
      };
      await writeXlsx(ExcelJS, res, where, params, info);
    } catch (err) {
      if (!res.headersSent) {
        // Nessun byte inviato: si risponde con un normale errore JSON.
        res.removeHeader('Content-Disposition');
        throw err;
      }
      // Gli header sono già partiti: non si può più rispondere con un JSON. Si
      // interrompe la connessione, così il download risulta fallito e non un file monco.
      console.error('[export] errore durante lo streaming', err);
      res.destroy(err);
    }
  })
);

module.exports = router;

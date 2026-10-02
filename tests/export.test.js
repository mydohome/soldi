'use strict';

// PR F — esportazione dei movimenti (xlsx/csv).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const h = require('./helpers');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let server;
before(async () => {
  await h.prepareDatabase();
  // Lotti piccoli per esercitare la paginazione a chiave anche con poche righe.
  server = await h.startServer({ EXPORT_BATCH_SIZE: '7', EXPORT_MAX_ROWS: '60', EXPORT_RATE_MAX: '1000' });
});
after(async () => {
  await server.stop();
  await h.closePool();
});

const dl = (c, qs = '', { cookie = c?.cookie } = {}) =>
  fetch(`${server.base}/api/export/transactions${qs ? `?${qs}` : ''}`, { headers: cookie ? { cookie } : {} });

async function readXlsx(res) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  return wb;
}
const rowsOf = (ws) => {
  const out = [];
  ws.eachRow((row, n) => n > 1 && out.push(row.values.slice(1)));
  return out;
};

async function seedUser(tag) {
  const c = await h.registerUser(server.base, tag);
  const cats = (await c.get('/api/categories')).body.categories;
  const accs = (await c.get('/api/accounts')).body.accounts;
  const cat = cats.find((x) => x.kind === 'expense') || cats[0];
  return { c, cat, acc: accs[0] };
}

describe('F — export xlsx', () => {
  it('200, MIME e nome file; intestazioni, date vere, importi numerici, Netto col segno, foglio Info', async () => {
    const { c, cat, acc } = await seedUser('x1');
    await c.post('/api/transactions', { type: 'expense', amount: 12.5, categoryId: cat.id, accountId: acc.id, scope: 'home', note: 'Spesa', occurredOn: '2026-03-10' });
    await c.post('/api/transactions', { type: 'income', amount: 2000, scope: 'personal', note: 'Stipendio', occurredOn: '2026-03-27' });
    await h.query('UPDATE users SET display_name = $2 WHERE id = $1', [c.user.id, 'Mario Rossi']);

    const res = await dl(c);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), XLSX_MIME);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="soldi-movimenti-\d{4}-\d{2}-\d{2}\.xlsx"$/);

    const wb = await readXlsx(res);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Movimenti', 'Info']);
    const ws = wb.getWorksheet('Movimenti');
    assert.deepEqual(ws.getRow(1).values.slice(1), ['Data', 'Tipo', 'Importo', 'Categoria', 'Conto', 'Ambito', 'Nota', 'Netto', 'Spesa fissa']);
    assert.equal(ws.getRow(1).font.bold, true);
    assert.equal(ws.views[0].state, 'frozen');
    assert.ok(ws.autoFilter);

    const rows = rowsOf(ws);
    assert.equal(rows.length, 2);
    // ordine: data decrescente
    assert.ok(rows[0][0] instanceof Date);
    assert.equal(rows[0][0].toISOString().slice(0, 10), '2026-03-27');
    assert.equal(ws.getCell('A2').numFmt, 'dd/mm/yyyy');
    assert.deepEqual([rows[0][1], rows[0][2], rows[0][7]], ['Entrata', 2000, 2000]);
    assert.equal(rows[0][3] ?? null, null); // categoria assente → cella vuota
    assert.equal(rows[1][0].toISOString().slice(0, 10), '2026-03-10');
    assert.deepEqual([rows[1][1], rows[1][2], rows[1][5], rows[1][7]], ['Spesa', 12.5, 'Casa', -12.5]);
    assert.equal(rows[1][3], cat.name);
    assert.equal(rows[1][4], acc.name);
    assert.equal(typeof rows[1][2], 'number');

    const info = Object.fromEntries(rowsOf(wb.getWorksheet('Info')).concat([wb.getWorksheet('Info').getRow(1).values.slice(1)]));
    assert.equal(info['Utente'], 'Mario Rossi');
    assert.equal(info['Movimenti esportati'], 2);
    assert.equal(info['Periodo'], 'Tutti i movimenti');
    assert.ok(info['Esportato il']);
    const text = JSON.stringify([...wb.getWorksheet('Info').getSheetValues()]);
    assert.ok(!text.includes(c.user.email), 'l’email non deve comparire nel file');
  });

  it('nota che inizia con = resta invariata come stringa (nessuna formula)', async () => {
    const { c } = await seedUser('x2');
    await c.post('/api/transactions', { type: 'expense', amount: 1, note: '=HYPERLINK("http://x")', occurredOn: '2026-04-01' });
    const ws = (await readXlsx(await dl(c))).getWorksheet('Movimenti');
    const cell = ws.getCell('G2');
    assert.equal(cell.value, '=HYPERLINK("http://x")');
    assert.equal(typeof cell.value, 'string');
  });

  it('i filtri restringono come GET /api/transactions', async () => {
    const { c, cat, acc } = await seedUser('x3');
    const cats = (await c.get('/api/categories')).body.categories;
    const other = cats.find((x) => x.id !== cat.id);
    const post = (b) => c.post('/api/transactions', { amount: 10, ...b });
    await post({ type: 'expense', categoryId: cat.id, accountId: acc.id, scope: 'home', note: 'alfa caffè', occurredOn: '2026-01-05' });
    await post({ type: 'expense', categoryId: other.id, scope: 'personal', note: 'beta', occurredOn: '2026-02-05' });
    await post({ type: 'income', scope: 'personal', note: 'gamma', occurredOn: '2026-03-05' });
    await post({ type: 'expense', categoryId: cat.id, scope: 'personal', note: '100% _vero_', occurredOn: '2026-04-05' });

    const cases = ['from=2026-02-01&to=2026-03-31', 'type=income', 'scope=home', `categoryId=${cat.id}`, `accountId=${acc.id}`, 'q=caff', 'q=%25', 'type=expense&scope=personal&from=2026-02-01'];
    for (const qs of cases) {
      const expected = (await c.get(`/api/transactions?${qs}&limit=500`)).body.transactions;
      const res = await dl(c, qs);
      assert.equal(res.status, 200, qs);
      const rows = rowsOf((await readXlsx(res)).getWorksheet('Movimenti'));
      assert.equal(rows.length, expected.length, qs);
      assert.deepEqual(rows.map((r) => r[0].toISOString().slice(0, 10)), expected.map((t) => t.occurredOn), qs);
    }
    const none = rowsOf((await readXlsx(await dl(c, 'type=income&scope=home'))).getWorksheet('Movimenti'));
    assert.equal(none.length, 0);
  });

  it('spesa fissa: il nome della regola compare nella colonna "Spesa fissa"', async () => {
    const { c } = await seedUser('x4');
    const r = await h.query(
      `INSERT INTO recurring_rules (user_id, name, type, amount_cents, scope, cadence, day_of_month, active, start_month)
       VALUES ($1, 'Affitto', 'expense', 50000, 'home', 'monthly', 1, false, '2026-01-01') RETURNING id`,
      [c.user.id]
    );
    await h.query(
      `INSERT INTO transactions (user_id, type, amount_cents, scope, recurring_rule_id, occurred_on, note) VALUES ($1,'expense',50000,'home',$2,'2026-01-01','Affitto')`,
      [c.user.id, r.rows[0].id]
    );
    const rows = rowsOf((await readXlsx(await dl(c))).getWorksheet('Movimenti'));
    assert.equal(rows[0][8], 'Affitto');
  });

  it('paginazione a lotti: tutte le righe, senza doppioni, anche con molte date uguali', async () => {
    const { c } = await seedUser('x5');
    await h.query(
      `INSERT INTO transactions (user_id, type, amount_cents, scope, note, occurred_on)
       SELECT $1, 'expense', 100 + g, 'personal', 'n' || g, DATE '2026-05-01' + (g / 5)::int FROM generate_series(1, 50) g`,
      [c.user.id]
    );
    const rows = rowsOf((await readXlsx(await dl(c))).getWorksheet('Movimenti'));
    assert.equal(rows.length, 50);
    assert.equal(new Set(rows.map((r) => r[6])).size, 50);
    const dates = rows.map((r) => r[0].getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  });

  it('risposta in streaming: nessun Content-Length e i primi byte arrivano prima della fine', async () => {
    const { c } = await seedUser('x6');
    await h.query(
      `INSERT INTO transactions (user_id, type, amount_cents, scope, note, occurred_on)
       SELECT $1, 'expense', 100 + g, 'personal', 'nota ' || g, DATE '2026-01-01' + (g % 300) FROM generate_series(1, 55) g`,
      [c.user.id]
    );
    const res = await dl(c);
    assert.equal(res.headers.get('content-length'), null);
    assert.match(res.headers.get('transfer-encoding') || '', /chunked/);
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.length);
    }
    assert.ok(chunks.length > 1, `attesi più chunk, ricevuti ${chunks.length}`);
  });
});

describe('F — export csv', () => {
  it('BOM, separatore ;, CRLF, importi con virgola, neutralizzazione delle formule', async () => {
    const { c } = await seedUser('c1');
    await c.post('/api/transactions', { type: 'expense', amount: 1234.5, note: '=1+1', occurredOn: '2026-06-02' });
    await c.post('/api/transactions', { type: 'income', amount: 3, note: 'a;b "c"', occurredOn: '2026-06-01' });
    await c.post('/api/transactions', { type: 'expense', amount: 3, note: '-cmd', occurredOn: '2026-05-01' });
    await c.post('/api/transactions', { type: 'expense', amount: 3, note: '@x', occurredOn: '2026-04-01' });
    await c.post('/api/transactions', { type: 'expense', amount: 3, note: '+x', occurredOn: '2026-03-01' });

    const res = await dl(c, 'format=csv');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /filename="soldi-movimenti-\d{4}-\d{2}-\d{2}\.csv"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = buf.toString('utf8').slice(1).split('\r\n');
    assert.equal(lines[0], 'Data;Tipo;Importo;Categoria;Conto;Ambito;Nota;Netto;Spesa fissa');
    assert.equal(lines[1], "02/06/2026;Spesa;1234,50;;;Personale;'=1+1;-1234,50;");
    assert.equal(lines[2], '01/06/2026;Entrata;3,00;;;Personale;"a;b ""c""";3,00;');
    assert.match(lines[3], /;'-cmd;/);
    assert.match(lines[4], /;'@x;/);
    assert.match(lines[5], /;'\+x;/);
    assert.equal(lines[6], ''); // CRLF finale
  });

  it('i filtri valgono anche per il CSV', async () => {
    const { c } = await seedUser('c2');
    await c.post('/api/transactions', { type: 'expense', amount: 1, occurredOn: '2026-01-01' });
    await c.post('/api/transactions', { type: 'income', amount: 1, occurredOn: '2026-01-02' });
    const lines = (await (await dl(c, 'format=csv&type=income')).text()).split('\r\n').filter(Boolean);
    assert.equal(lines.length, 2);
  });
});

describe('F — sicurezza e validazione', () => {
  it('senza sessione → 401', async () => {
    assert.equal((await dl(null)).status, 401);
    assert.equal((await dl(null, 'format=csv')).status, 401);
  });

  it('parametri non validi → 400 (date inesistenti, formato, tipo)', async () => {
    const { c } = await seedUser('v1');
    for (const qs of ['from=2026-02-31', 'to=2026-13-01', 'from=ieri', 'format=pdf', 'type=boh', 'categoryId=abc']) {
      assert.equal((await dl(c, qs)).status, 400, qs);
    }
  });

  it('isolamento: l’export di B non contiene movimenti di A, nemmeno filtrando per id di A', async () => {
    const a = await seedUser('iso-a');
    const b = await seedUser('iso-b');
    await a.c.post('/api/transactions', { type: 'expense', amount: 77, categoryId: a.cat.id, accountId: a.acc.id, note: 'SEGRETO-A', occurredOn: '2026-02-02' });
    await b.c.post('/api/transactions', { type: 'expense', amount: 5, note: 'di B', occurredOn: '2026-02-03' });

    for (const qs of ['', `categoryId=${a.cat.id}`, `accountId=${a.acc.id}`, 'q=SEGRETO']) {
      const wb = await readXlsx(await dl(b.c, qs));
      const all = JSON.stringify(wb.getWorksheet('Movimenti').getSheetValues()) + JSON.stringify(wb.getWorksheet('Info').getSheetValues());
      assert.ok(!all.includes('SEGRETO-A'), qs);
      assert.ok(!all.includes(a.cat.name) || a.cat.name === b.cat.name, qs); // le categorie di default hanno nomi uguali
      if (!qs) assert.equal(rowsOf(wb.getWorksheet('Movimenti')).length, 1);
      else assert.equal(rowsOf(wb.getWorksheet('Movimenti')).length, 0, qs);
    }
    const csv = await (await dl(b.c, `format=csv&categoryId=${a.cat.id}`)).text();
    assert.ok(!csv.includes('SEGRETO-A'));
    // il foglio Info non rivela il nome della categoria di A
    const info = (await readXlsx(await dl(b.c, `categoryId=${a.cat.id}`))).getWorksheet('Info').getSheetValues();
    assert.ok(JSON.stringify(info).includes('(non trovata)'));
  });

  it('oltre il tetto → 400 con il messaggio previsto; al tetto → 200', async () => {
    const { c } = await seedUser('cap');
    await h.query(
      `INSERT INTO transactions (user_id, type, amount_cents, scope, note, occurred_on)
       SELECT $1, 'expense', 100, 'personal', 'n', DATE '2026-01-01' + (g % 200) FROM generate_series(1, 61) g`,
      [c.user.id]
    );
    for (const f of ['xlsx', 'csv']) {
      const res = await dl(c, `format=${f}`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'too_many_rows');
      assert.equal(body.message, 'Troppi movimenti: restringi il periodo');
      assert.equal(res.headers.get('content-disposition'), null);
    }
    assert.equal((await dl(c, 'from=2026-01-01&to=2026-01-30')).status, 200); // 61 righe distribuite: il periodo stretto ne ha meno del tetto
  });

  it('rate limit: dopo 6 richieste al minuto → 429 (limite predefinito)', async () => {
    const s = await h.startServer(); // senza EXPORT_RATE_MAX
    try {
      const c = await h.registerUser(s.base, 'rl');
      const statuses = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await fetch(`${s.base}/api/export/transactions?format=csv`, { headers: { cookie: c.cookie } })).status);
      }
      assert.deepEqual(statuses.slice(0, 6), Array(6).fill(200));
      assert.equal(statuses[6], 429);
    } finally {
      await s.stop();
    }
  });
});

describe('F — exceljs mancante', () => {
  it('xlsx → 503 con messaggio chiaro, csv continua a funzionare', async () => {
    // Un secondo server con una cartella node_modules priva di exceljs è fragile:
    // si simula il MODULE_NOT_FOUND con un hook di --require.
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soldi-nox-')), 'no-exceljs.js');
    fs.writeFileSync(
      hook,
      `const M = require('module'); const orig = M._resolveFilename;
       M._resolveFilename = function (req, ...a) { if (req === 'exceljs') { const e = new Error("Cannot find module 'exceljs'"); e.code = 'MODULE_NOT_FOUND'; throw e; } return orig.call(this, req, ...a); };`
    );
    const s = await h.startServer({ NODE_OPTIONS: `--require ${hook}` });
    try {
      const c = await h.registerUser(s.base, 'nox');
      await c.post('/api/transactions', { type: 'expense', amount: 1, occurredOn: '2026-01-01' });
      const x = await fetch(`${s.base}/api/export/transactions`, { headers: { cookie: c.cookie } });
      assert.equal(x.status, 503);
      const body = await x.json();
      assert.equal(body.error, 'xlsx_unavailable');
      assert.match(body.message, /ricostruita.*\.\/update\.sh.*CSV/);
      const csv = await fetch(`${s.base}/api/export/transactions?format=csv`, { headers: { cookie: c.cookie } });
      assert.equal(csv.status, 200);
      assert.equal((await csv.text()).split('\r\n').filter(Boolean).length, 2);
    } finally {
      await s.stop();
    }
  });
});

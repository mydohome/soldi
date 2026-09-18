'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// Columns where an empty CSV field is a real empty string, not NULL.
const KEEP_EMPTY = new Set(['note', 'display_name']);

/**
 * Legge <table>.csv da una cartella di backup e ritorna { columns, rows }.
 * Usa solo le colonne presenti nell'header del CSV, così un backup più
 * vecchio (senza una tabella o alcune colonne) si ripristina comunque — i
 * default del DB coprono le mancanze. Un file assente è trattato come
 * tabella vuota, con un avviso.
 */
function readTableCsv(dir, table) {
  const file = path.join(dir, `${table.name}.csv`);
  if (!fs.existsSync(file)) {
    console.warn(`[restore]   ${table.name}.csv non nel backup — salto (formato più vecchio?)`);
    return { columns: [], rows: [] };
  }
  const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true });
  const present = records.length
    ? table.columns.filter((col) => col in records[0])
    : table.columns;
  const rows = records.map((rec) =>
    present.map((col) => {
      const raw = rec[col];
      if (raw === undefined || raw === '') return raw === '' && KEEP_EMPTY.has(col) ? '' : null;
      return raw;
    })
  );
  return { columns: present, rows };
}

module.exports = { readTableCsv };

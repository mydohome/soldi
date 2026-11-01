'use strict';

// Calendario delle spese fisse: funzioni pure, senza database. Condivise da
// generate.js (generazione dei movimenti), planned.js (previsto annuale),
// routes/recurring.js (avanzamento, cambio della data di inizio) e
// routes/transactions.js (eliminazione di una rata). Date: stringhe YYYY-MM-DD.
//
// Modello: una regola ha una sequenza di «slot» (mesi in cui scatta): ogni mese dallo
// start_month per le mensili, il mese `month` di ogni anno per le annuali. Le rate
// «saltate» (skipped_months, 'YYYY-MM' separati da virgola) non sono slot: se la regola ha
// un numero di rate (total_occurrences), il piano riempie le rate sui primi slot NON saltati,
// quindi saltare un mese sposta la data finale in avanti di uno slot.

const pad = (n) => String(n).padStart(2, '0');
const monthStart = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;

function addMonthsKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthStart(dt);
}
/** Differenza in mesi tra due chiavi (to - from). */
function monthsBetween(from, to) {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
}
const monthKey = (s) => `${String(s).slice(0, 7)}-01`; // '2026-03-15' | '2026-03' → '2026-03-01'

/** Insieme delle rate saltate ('YYYY-MM'), da stringa o array. */
function skippedSet(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  return new Set(list.map((x) => String(x).trim().slice(0, 7)).filter((x) => /^\d{4}-\d{2}$/.test(x)));
}
const skippedToString = (set) => [...set].sort().join(',');

/** Mese del primo slot: l'inizio per le mensili; il primo `month` dall'inizio in poi per le annuali. */
function firstSlotKey(rule, startMonth) {
  const sm = startMonth || monthKey(rule.start_month);
  if (rule.cadence !== 'yearly') return sm;
  const sy = Number(sm.slice(0, 4));
  const smm = Number(sm.slice(5, 7));
  return `${smm > rule.month ? sy + 1 : sy}-${pad(rule.month)}-01`;
}
const slotAt = (rule, first, i) =>
  rule.cadence === 'yearly' ? `${Number(first.slice(0, 4)) + i}-${pad(rule.month)}-01` : addMonthsKey(first, i);

/**
 * Gli slot a cui sono assegnate le rate di una regola a durata limitata, in ordine (ne ha
 * esattamente total_occurrences); [] se è a tempo indeterminato o annuale senza mese.
 */
function scheduleSlots(rule, startMonth) {
  const total = rule.total_occurrences;
  if (total == null || (rule.cadence === 'yearly' && rule.month == null)) return [];
  const first = firstSlotKey(rule, startMonth);
  const skipped = skippedSet(rule.skipped_months);
  const out = [];
  for (let i = 0; out.length < total && i < total + skipped.size + 1; i++) {
    const key = slotAt(rule, first, i);
    if (!skipped.has(key.slice(0, 7))) out.push(key);
  }
  return out;
}

/**
 * Mese dell'ultima rata di una regola a durata limitata, o null se è a tempo indeterminato.
 * Mensile: N rate dal primo mese (saltando i mesi saltati); annuale: N occorrenze.
 */
function scheduleEndMonth(rule, startMonth) {
  if (rule.total_occurrences == null) return null;
  const slots = scheduleSlots(rule, startMonth);
  return slots.length ? slots[slots.length - 1] : null;
}

/**
 * Se `date` (YYYY-MM-DD) cade in uno slot del piano della regola (non saltato, e per le regole
 * a durata limitata entro l'ultima rata), ritorna la chiave del mese ('YYYY-MM-01'); altrimenti null.
 */
function slotMonthForDate(rule, date) {
  const key = monthKey(date);
  const skipped = skippedSet(rule.skipped_months);
  if (skipped.has(key.slice(0, 7))) return null;
  if (rule.cadence === 'yearly' && rule.month == null) return null;
  const first = firstSlotKey(rule);
  if (key < first) return null;
  if (rule.cadence === 'yearly') {
    if (Number(key.slice(5, 7)) !== rule.month) return null;
  }
  if (rule.total_occurrences != null) return scheduleSlots(rule).includes(key) ? key : null;
  return key;
}

/**
 * Per ciascun mese dell'anno `yr`, true se la regola è in vigore in quel mese: dallo start_month in
 * poi, senza i mesi saltati e, se ha una durata (total_occurrences), non oltre l'ultima rata.
 */
function recurringHits(rule, yr) {
  const limited = rule.total_occurrences != null;
  const slots = limited ? new Set(scheduleSlots(rule)) : null;
  const first = firstSlotKey(rule);
  const skipped = skippedSet(rule.skipped_months);
  return Array.from({ length: 12 }, (_, i) => {
    const key = `${yr}-${pad(i + 1)}-01`;
    if (rule.cadence === 'yearly' && rule.month !== i + 1) return false;
    if (limited) return slots.has(key);
    return key >= first && !skipped.has(key.slice(0, 7));
  });
}

/**
 * Rate "scadute" finora secondo il calendario della regola, calcolate dal cursore
 * last_run_month: gli slot del piano fino al cursore compreso. Intero tra 0 e total.
 *
 * Non si usa COUNT(*) dei movimenti: se un movimento generato viene eliminato (o dopo
 * un'importazione) il contatore scende, mentre il piano a calendario va avanti e termina comunque
 * alla data prevista. L'utente può però chiedere di «aggiornare le rate» quando elimina un
 * movimento: quel mese diventa una rata saltata (skipped_months) e il piano slitta di conseguenza.
 * Una pausa non sposta la fine del piano: il cursore, riattivando la regola, salta ai mesi correnti.
 */
function installmentsDone(rule) {
  const total = rule.total_occurrences;
  if (total == null || !rule.last_run_month) return 0;
  const cursor = monthKey(rule.last_run_month);
  return scheduleSlots(rule).filter((k) => k <= cursor).length;
}

/**
 * Avanzamento di una regola a durata limitata (null se indefinita). Gli importi si calcolano in
 * centesimi interi e si convertono in euro solo alla fine.
 *
 * Semantica: l'avanzamento segue il calendario; mettere in pausa una regola non sposta la data di
 * fine né ricalcola le rate. Il residuo usa l'importo CORRENTE della regola (rate future × importo);
 * "versato" è la somma reale dei movimenti collegati, quindi planTotal resta coerente se
 * l'importo è cambiato nel tempo.
 */
function installmentProgress(rule, paidCents) {
  const total = rule.total_occurrences;
  if (total == null) return null;
  const done = installmentsDone(rule);
  const remaining = total - done;
  const remainingCents = remaining * Number(rule.amount_cents);
  const paid = Number(paidCents);
  const end = scheduleEndMonth(rule, monthKey(rule.start_month));
  return {
    done,
    total,
    remaining,
    percent: Math.round((done / total) * 100),
    completed: done >= total,
    paid: paid / 100,
    remainingAmount: remainingCents / 100,
    planTotal: (paid + remainingCents) / 100,
    endMonth: end ? end.slice(0, 7) : null,
  };
}

/**
 * Slot del piano (non saltati) strettamente dopo il cursore e fino a `lastDue` compreso: i mesi che
 * generateDue creerebbe. Per le regole indeterminate si contano i mesi (o i `month` annuali).
 * `cursor` null = nessun mese ancora generato.
 */
function dueSlots(rule, cursor, lastDue) {
  const first = firstSlotKey(rule);
  const from = cursor ? addMonthsKey(monthKey(cursor), 1) : first;
  const out = [];
  if (rule.cadence === 'yearly' && rule.month == null) return out;
  const end = scheduleEndMonth(rule, monthKey(rule.start_month));
  const to = end && end < lastDue ? end : lastDue;
  const skipped = skippedSet(rule.skipped_months);
  for (let m = from < first ? first : from, guard = 0; m <= to && guard < 2400; m = addMonthsKey(m, 1), guard++) {
    if (rule.cadence === 'yearly' && Number(m.slice(5, 7)) !== rule.month) continue;
    if (skipped.has(m.slice(0, 7))) continue;
    out.push(m);
  }
  return out;
}

module.exports = {
  monthStart, addMonthsKey, monthsBetween, monthKey, skippedSet, skippedToString, firstSlotKey,
  scheduleSlots, scheduleEndMonth, slotMonthForDate, recurringHits, installmentsDone, installmentProgress, dueSlots,
};

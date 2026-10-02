'use strict';

// Calendario delle spese fisse: funzioni pure, senza database. Condivise da
// generate.js (generazione dei movimenti), planned.js (previsto annuale) e
// routes/recurring.js (avanzamento). Tutte le date sono stringhe YYYY-MM-DD.

const pad = (n) => String(n).padStart(2, '0');
const monthStart = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;

function addMonthsKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthStart(dt);
}

/**
 * Month of a fixed-length rule's last scheduled occurrence, or null when the
 * rule runs indefinitely. A 'monthly' rule of N rate ends N-1 months after its
 * start; a 'yearly' rule of N occurrences ends N-1 years after its first fire.
 */
function scheduleEndMonth(rule, startMonth) {
  if (rule.total_occurrences == null) return null;
  const n = rule.total_occurrences;
  if (rule.cadence === 'yearly') {
    const [sy, sm] = startMonth.split('-').map(Number);
    const firstYear = sm > rule.month ? sy + 1 : sy;
    return `${firstYear + n - 1}-${pad(rule.month)}-01`;
  }
  return addMonthsKey(startMonth, n - 1);
}

/**
 * Per ciascun mese dell'anno `yr`, true se la regola è in vigore in quel mese:
 * dal start_month in poi e, se ha una durata (total_occurrences), non oltre.
 * Stessa logica di scheduleEndMonth().
 */
const absMonth = (y, m) => y * 12 + (m - 1);
function recurringHits(rule, yr) {
  const sy = Number(rule.start_month.slice(0, 4));
  const sm = Number(rule.start_month.slice(5, 7));
  const n = rule.total_occurrences; // null = indefinita
  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    if (rule.cadence === 'monthly') {
      const diff = absMonth(yr, m) - absMonth(sy, sm);
      return diff >= 0 && (n == null || diff < n);
    }
    if (m !== rule.month) return false;
    const firstYear = sm > rule.month ? sy + 1 : sy;
    return yr >= firstYear && (n == null || yr - firstYear < n);
  });
}

/**
 * Rate "scadute" finora secondo il calendario della regola, calcolate dal cursore
 * last_run_month (stringhe YYYY-MM-DD). Ritorna un intero tra 0 e total.
 *
 * Non si usa COUNT(*) dei movimenti: se un movimento generato viene eliminato (o
 * dopo un'importazione) il contatore scende, mentre il piano a calendario va
 * avanti e termina comunque alla data prevista. Per lo stesso motivo una pausa
 * non sposta la fine del piano: il cursore, riattivando la regola, salta ai mesi
 * correnti (vedi PATCH in routes/recurring.js).
 */
function installmentsDone(rule) {
  const total = rule.total_occurrences;
  if (total == null || !rule.last_run_month) return 0;
  if (rule.cadence === 'yearly' && rule.month == null) return 0; // dato storico incoerente
  const sy = Number(rule.start_month.slice(0, 4));
  const sm = Number(rule.start_month.slice(5, 7));
  const cy = Number(rule.last_run_month.slice(0, 4));
  const cm = Number(rule.last_run_month.slice(5, 7));
  let done;
  if (rule.cadence === 'yearly') {
    const firstYear = sm > rule.month ? sy + 1 : sy;
    done = cm >= rule.month ? cy - firstYear + 1 : cy - firstYear;
  } else {
    done = cy * 12 + cm - (sy * 12 + sm) + 1;
  }
  return Math.max(0, Math.min(total, done));
}

/**
 * Avanzamento di una regola a durata limitata (null se indefinita). Gli importi
 * si calcolano in centesimi interi e si convertono in euro solo alla fine.
 *
 * Semantica: l'avanzamento segue il calendario; mettere in pausa una regola non
 * sposta la data di fine né ricalcola le rate. Il residuo usa l'importo CORRENTE
 * della regola (rate future × importo); "versato" è la somma reale dei movimenti
 * collegati, quindi planTotal resta coerente se l'importo è cambiato nel tempo.
 */
function installmentProgress(rule, paidCents) {
  const total = rule.total_occurrences;
  if (total == null) return null;
  const done = installmentsDone(rule);
  const remaining = total - done;
  const remainingCents = remaining * Number(rule.amount_cents);
  const paid = Number(paidCents);
  const yearlyBroken = rule.cadence === 'yearly' && rule.month == null;
  return {
    done,
    total,
    remaining,
    percent: Math.round((done / total) * 100),
    completed: done >= total,
    paid: paid / 100,
    remainingAmount: remainingCents / 100,
    planTotal: (paid + remainingCents) / 100,
    endMonth: yearlyBroken ? null : scheduleEndMonth(rule, rule.start_month).slice(0, 7),
  };
}

module.exports = { monthStart, addMonthsKey, scheduleEndMonth, recurringHits, installmentsDone, installmentProgress };

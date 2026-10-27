'use strict';

/**
 * Calendario dei pagamenti programmati (puro, senza database).
 * Importi in centesimi interi; date come stringhe 'YYYY-MM-DD'.
 */

const pad = (n) => String(n).padStart(2, '0');

/** Oggi nel fuso del server (TZ), come stringa YYYY-MM-DD. */
function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

/**
 * `date` spostata di `months` mesi mantenendo il giorno, ma senza uscire dal mese di arrivo
 * (31 gennaio + 1 mese = 28/29 febbraio). Si parte sempre dalla data originale, non da quella
 * precedente: 31/01 → 28/02 → 31/03 e non 28/03.
 */
function addMonthsClamped(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

/** Differenza in giorni (b − a) tra due date YYYY-MM-DD. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Propone le rate di un piano.
 *   mode 'each'  → ogni rata vale `amountCents`
 *   mode 'total' → `amountCents` è il totale, diviso in `count` parti; il resto dei centesimi
 *                  va sull'ultima rata (€100,00 in 3 rate = 33,33 + 33,33 + 33,34).
 * → [{ dueOn, amountCents }]
 */
function generateInstallments({ count, firstDue, everyMonths = 1, mode = 'each', amountCents }) {
  const out = [];
  const base = mode === 'total' ? Math.floor(amountCents / count) : amountCents;
  const rest = mode === 'total' ? amountCents - base * count : 0;
  for (let i = 0; i < count; i += 1) {
    out.push({
      dueOn: addMonthsClamped(firstDue, i * everyMonths),
      amountCents: base + (i === count - 1 ? rest : 0),
    });
  }
  return out;
}

/**
 * Stato di una rata rispetto a oggi:
 *   'paid' | 'overdue' (scaduta prima di oggi) | 'today' | 'upcoming'.
 * `daysOverdue` > 0 solo per le scadute.
 */
function installmentStatus({ dueOn, paid }, today) {
  if (paid) return { status: 'paid', daysOverdue: 0, daysToDue: null };
  const diff = daysBetween(dueOn, today); // > 0: scaduta da `diff` giorni
  if (diff > 0) return { status: 'overdue', daysOverdue: diff, daysToDue: null };
  if (diff === 0) return { status: 'today', daysOverdue: 0, daysToDue: 0 };
  return { status: 'upcoming', daysOverdue: 0, daysToDue: -diff };
}

module.exports = { todayKey, addMonthsClamped, daysBetween, generateInstallments, installmentStatus };

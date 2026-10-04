'use strict';

// Eliminare il movimento di una rata di una spesa fissa: che effetto avrebbe «aggiornare lo stato
// delle rate»? Funzioni pure (nessun database), usate da routes/transactions.js.
//
// Aggiornare le rate = il mese di quel movimento diventa una rata «saltata» (skipped_months): la rata
// non risulta più addebitata e, se la regola ha un numero di rate, l'ultima slitta di uno slot.
// Senza aggiornare, il movimento sparisce ma la rata resta contata come addebitata (il piano a
// calendario va avanti come prima).

const {
  scheduleSlots, scheduleEndMonth, slotMonthForDate, installmentsDone, skippedSet, skippedToString,
  dueSlots, addMonthsKey, monthKey,
} = require('./schedule');

/** Ultimo mese per cui, adesso, generateDue ha già qualcosa da creare (stessa logica di generate.js). */
function lastDueKey(rule, now = new Date()) {
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return now.getUTCDate() >= rule.day_of_month ? cur : addMonthsKey(cur, -1);
}

/**
 * Impatto dell'aggiornamento delle rate per il movimento di `rule` datato `occurredOn`
 * (YYYY-MM-DD). Ritorna null se non è applicabile: regola a tempo indeterminato, mese fuori dal
 * piano o già saltato, rata non ancora generata.
 */
function rateImpact(rule, occurredOn, now = new Date()) {
  if (rule.total_occurrences == null) return null;
  const slot = slotMonthForDate(rule, occurredOn);
  if (!slot) return null;
  if (!rule.last_run_month || slot > monthKey(rule.last_run_month)) return null;
  const slots = scheduleSlots(rule);
  const skippedAfter = skippedSet(rule.skipped_months);
  skippedAfter.add(slot.slice(0, 7));
  const after = { ...rule, skipped_months: skippedToString(skippedAfter) };
  const endBefore = scheduleEndMonth(rule);
  const endAfter = scheduleEndMonth(after);
  return {
    slot,
    number: slots.indexOf(slot) + 1,
    total: rule.total_occurrences,
    doneBefore: installmentsDone(rule),
    doneAfter: installmentsDone(after),
    completed: installmentsDone(rule) >= rule.total_occurrences,
    endBefore: endBefore.slice(0, 7),
    endAfter: endAfter.slice(0, 7),
    // se la nuova ultima rata è già «dovuta», il movimento corrispondente viene creato subito
    willGenerateNow: dueSlots(after, rule.last_run_month, lastDueKey(rule, now)).length > 0,
    skippedAfter: after.skipped_months,
  };
}

module.exports = { rateImpact, lastDueKey };

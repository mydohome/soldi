'use strict';

const { pool } = require('../db/pool');

const pad = (n) => String(n).padStart(2, '0');
const monthStart = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;

function addMonthsKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthStart(dt);
}

/** occurred_on for a rule in a given month key, e.g. ('2026-03-01', 15) -> '2026-03-15'. */
function occurredOn(monthKey, dayOfMonth) {
  return `${monthKey.slice(0, 8)}${pad(dayOfMonth)}`;
}

/**
 * Create the movimenti that active recurring rules owe up to (and including)
 * the current month. A rule owes the current month only once the day of month
 * has arrived. Safe to run repeatedly — a unique index prevents duplicates and
 * each rule's last_run_month is advanced.
 *
 * @param {object} [opts]
 * @param {number} [opts.userId]  limit to one user (used by the "run now" button)
 * @param {Date}   [opts.now]     override "today" (tests)
 * @returns {Promise<{created:number, rules:number}>}
 */
async function generateDue({ userId, now = new Date() } = {}) {
  const currentMonth = monthStart(now);
  const currentDay = now.getUTCDate();

  const client = await pool.connect();
  let created = 0;
  let rulesTouched = 0;
  try {
    await client.query('BEGIN');

    const { rows: rules } = await client.query(
      `SELECT * FROM recurring_rules
       WHERE active = true ${userId ? 'AND user_id = $1' : ''}
       FOR UPDATE`,
      userId ? [userId] : []
    );

    for (const rule of rules) {
      const startMonth = monthStart(new Date(rule.start_month));
      const lastRun = rule.last_run_month ? monthStart(new Date(rule.last_run_month)) : null;

      // First month still to generate.
      const fromMonth = lastRun ? addMonthsKey(lastRun, 1) : startMonth;
      // Last month that is actually due now.
      const lastDueMonth =
        currentDay >= rule.day_of_month ? currentMonth : addMonthsKey(currentMonth, -1);

      if (lastDueMonth < fromMonth) continue; // nothing due
      rulesTouched++;

      for (let m = fromMonth; m <= lastDueMonth; m = addMonthsKey(m, 1)) {
        const res = await client.query(
          `INSERT INTO transactions
             (user_id, type, amount_cents, category_id, account_id, recurring_rule_id, scope, note, occurred_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [
            rule.user_id,
            rule.type,
            rule.amount_cents,
            rule.category_id,
            rule.account_id,
            rule.id,
            rule.scope,
            rule.note || rule.name,
            occurredOn(m, rule.day_of_month),
          ]
        );
        created += res.rowCount;
      }

      await client.query('UPDATE recurring_rules SET last_run_month = $2 WHERE id = $1', [
        rule.id,
        lastDueMonth,
      ]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { created, rules: rulesTouched };
}

module.exports = { generateDue };

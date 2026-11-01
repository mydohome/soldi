'use strict';

const cron = require('node-cron');
const { generateDue } = require('./generate');

/**
 * Generate the movimenti owed by active recurring rules.
 * Runs once at boot (catch-up after downtime) and then daily.
 * Override the schedule with RECURRING_CRON, disable with RECURRING_ENABLED=false.
 */
function startRecurringScheduler() {
  if (process.env.RECURRING_ENABLED === 'false') {
    console.log('[recurring] scheduler disabled (RECURRING_ENABLED=false)');
    return null;
  }

  const run = async (reason) => {
    try {
      const { created, rules } = await generateDue();
      if (created > 0) {
        console.log(`[recurring] ${reason}: created ${created} movimenti from ${rules} rule(s)`);
      }
    } catch (err) {
      console.error(`[recurring] ${reason} failed`, err);
    }
  };

  run('startup catch-up');

  const expression = process.env.RECURRING_CRON || '5 6 * * *'; // 06:05 every day
  if (!cron.validate(expression)) {
    console.error(`[recurring] invalid RECURRING_CRON "${expression}" — daily run not scheduled`);
    return null;
  }
  const task = cron.schedule(expression, () => run('daily run'));
  console.log(`[recurring] scheduler active (cron "${expression}")`);
  return task;
}

module.exports = { startRecurringScheduler };

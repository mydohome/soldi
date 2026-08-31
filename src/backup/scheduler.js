'use strict';

const cron = require('node-cron');
const { createBackup } = require('./backup-core');

/**
 * Schedule the automatic weekly CSV backup.
 * Defaults to Sundays at 03:00 (server time). Override with BACKUP_CRON.
 * Disable entirely with BACKUP_ENABLED=false.
 */
function startBackupScheduler() {
  if (process.env.BACKUP_ENABLED === 'false') {
    console.log('[backup] scheduler disabled (BACKUP_ENABLED=false)');
    return null;
  }
  const expression = process.env.BACKUP_CRON || '0 3 * * 0';
  if (!cron.validate(expression)) {
    console.error(`[backup] invalid BACKUP_CRON "${expression}" — scheduler not started`);
    return null;
  }

  const task = cron.schedule(expression, async () => {
    try {
      const dir = await createBackup({ label: 'weekly' });
      console.log(`[backup] weekly backup written to ${dir}`);
    } catch (err) {
      console.error('[backup] weekly backup failed', err);
    }
  });

  console.log(`[backup] weekly scheduler active (cron "${expression}")`);
  return task;
}

module.exports = { startBackupScheduler };

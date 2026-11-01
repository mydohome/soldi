'use strict';

const cron = require('node-cron');
const { query } = require('../db/pool');
const { createBackup, createUserBackup } = require('./backup-core');

/**
 * Backup di ogni utente, uno per uno — un errore su un utente (es. disco
 * pieno a metà) è loggato e non blocca gli altri.
 */
async function backupEveryUser() {
  const { rows: users } = await query('SELECT id, email FROM users ORDER BY id');
  for (const u of users) {
    try {
      const dir = await createUserBackup({ userId: u.id, email: u.email, label: 'weekly' });
      console.log(`[backup] weekly user backup for ${u.email} written to ${dir}`);
    } catch (err) {
      console.error(`[backup] weekly user backup failed for ${u.email}`, err);
    }
  }
}

/**
 * Schedule the automatic weekly CSV backup: uno globale (tutte le tabelle,
 * tutti gli utenti — per il disastro totale) più uno per ogni utente (solo i
 * suoi dati — per un ripristino mirato).
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
    await backupEveryUser();
  });

  console.log(`[backup] weekly scheduler active (cron "${expression}")`);
  return task;
}

module.exports = { startBackupScheduler };

'use strict';

const path = require('path');
const express = require('express');

const { requireAuth } = require('../auth/middleware');
const { handler } = require('../http/validate');
const { createUserBackup, listUserBackups, BACKUP_ROOT } = require('../backup/backup-core');
const { readManifest } = require('../backup/restore-user');

const router = express.Router();
router.use(requireAuth);

// Solo i backup DELL'UTENTE LOGGATO: il backup globale (tutti gli utenti
// insieme) non è mai raggiungibile via API, per non esporre dati di altri
// utenti — resta gestito solo da terminale/cron sul server (vedi
// scripts/disaster-recovery.sh e npm run backup/restore).
function listMyBackups(userId) {
  return listUserBackups(userId)
    .map((name) => {
      const manifest = readManifest(path.join(BACKUP_ROOT, name));
      return {
        name,
        createdAt: manifest?.createdAt || null,
        label: manifest?.label || null,
        tables: manifest?.tables || null,
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

router.get(
  '/',
  handler(async (req, res) => {
    res.json({ dir: BACKUP_ROOT, backups: listMyBackups(req.user.id) });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const dir = await createUserBackup({ userId: req.user.id, email: req.user.email, label: 'manual' });
    res.status(201).json({ created: path.basename(dir) });
  })
);

module.exports = router;

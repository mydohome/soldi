'use strict';

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');
const { createUserBackup, listUserBackups, BACKUP_ROOT } = require('../backup/backup-core');
const { readManifest, restoreUserBackup } = require('../backup/restore-user');

const router = express.Router();
router.use(requireAuth);

// Un backup manuale per utente ogni 30s: evita che un click ripetuto (o uno
// script rotto) generi I/O su disco inutile. La rotta è sempre autenticata
// (requireAuth sopra), quindi req.user.id esiste già qui.
const backupLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  message: { error: 'too_many_requests', message: 'Aspetta qualche secondo prima di creare un altro backup.' },
});

// Il ripristino sovrascrive tutti i dati dell'utente: un limite più permissivo
// del backup (che gira anche da cron) serve solo a evitare doppi invii/abusi,
// non a proteggere una risorsa costosa.
const restoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.id),
  message: { error: 'too_many_requests', message: 'Troppi ripristini in poco tempo. Riprova tra qualche minuto.' },
});

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
  backupLimiter,
  handler(async (req, res) => {
    const dir = await createUserBackup({ userId: req.user.id, email: req.user.email, label: 'manual' });
    res.status(201).json({ created: path.basename(dir) });
  })
);

// Il nome deve corrispondere esattamente a uno dei backup DELL'UTENTE LOGGATO
// (mai un path fornito dal client): esclude sia il path traversal sia il
// ripristino del backup di un altro utente (IDOR).
router.post(
  '/:name/restore',
  restoreLimiter,
  handler(async (req, res) => {
    const name = z.string().min(1).max(200).parse(req.params.name);
    if (!listMyBackups(req.user.id).some((b) => b.name === name)) {
      throw httpError(404, 'not_found', 'Backup non trovato');
    }
    const restored = await restoreUserBackup({ userId: req.user.id, dir: path.join(BACKUP_ROOT, name) });
    res.json({ restored });
  })
);

module.exports = router;

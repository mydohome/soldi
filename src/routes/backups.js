'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const { requireAuth } = require('../auth/middleware');
const { handler } = require('../http/validate');
const { createBackup, BACKUP_ROOT } = require('../backup/backup-core');

const router = express.Router();
router.use(requireAuth);

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('soldi-backup-'))
    .map((e) => {
      const manifestPath = path.join(BACKUP_ROOT, e.name, 'manifest.json');
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        /* ignore unreadable manifest */
      }
      return {
        name: e.name,
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
    res.json({ dir: BACKUP_ROOT, backups: listBackups() });
  })
);

router.post(
  '/',
  handler(async (req, res) => {
    const dir = await createBackup({ label: 'manual' });
    res.status(201).json({ created: path.basename(dir) });
  })
);

module.exports = router;

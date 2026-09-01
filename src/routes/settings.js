'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');

const { requireAuth } = require('../auth/middleware');
const { handler, httpError } = require('../http/validate');

const router = express.Router();
router.use(requireAuth);

// Host repo bind-mounted here (see docker-compose.yml). src/ and public/ are also
// mounted straight into /app, so a `git pull` + restart updates the running code
// without rebuilding the image.
const REPO = process.env.REPO_DIR || '/repo';
const SELF_UPDATE = process.env.SELF_UPDATE_ENABLED === 'true';

const git = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', REPO, '-c', 'safe.directory=' + REPO, ...args],
      { timeout: opts.timeout || 30000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))
    );
  });

const repoAvailable = () => {
  try {
    return fs.existsSync(path.join(REPO, '.git'));
  } catch {
    return false;
  }
};

router.get(
  '/version',
  handler(async (req, res) => {
    const out = {
      sha: process.env.GIT_SHA || null,
      shaShort: process.env.GIT_SHA ? process.env.GIT_SHA.slice(0, 7) : null,
      committedAt: null,
      repoAvailable: repoAvailable(),
      selfUpdateEnabled: SELF_UPDATE,
    };
    if (out.repoAvailable) {
      try {
        out.sha = await git(['rev-parse', 'HEAD']);
        out.shaShort = out.sha.slice(0, 7);
        out.committedAt = await git(['log', '-1', '--format=%cI']);
      } catch {
        /* keep env fallback */
      }
    }
    res.json(out);
  })
);

router.get(
  '/check-update',
  handler(async (req, res) => {
    if (!repoAvailable()) return res.json({ supported: false, reason: 'no_repo_mount' });
    try {
      await git(['fetch', '--quiet', 'origin', 'main'], { timeout: 25000 });
      const local = await git(['rev-parse', 'HEAD']);
      const remote = await git(['rev-parse', 'origin/main']);
      const behind =
        local === remote ? 0 : Number(await git(['rev-list', '--count', `${local}..origin/main`]));
      const log =
        behind > 0
          ? (await git(['log', '--format=%h %s', `${local}..origin/main`]))
              .split('\n')
              .filter(Boolean)
              .slice(0, 20)
          : [];
      res.json({
        supported: true,
        upToDate: behind === 0,
        behind,
        localShort: local.slice(0, 7),
        remoteShort: remote.slice(0, 7),
        log,
      });
    } catch (err) {
      res.json({ supported: false, reason: 'git_error', message: err.message });
    }
  })
);

/**
 * Pull origin/main and restart. src/ and public/ are bind-mounted, so the
 * restarted process runs the new code. Dependency changes trigger `npm ci`.
 * The container is restarted by compose (`restart: unless-stopped`).
 * Image/Dockerfile changes still need `./scripts/update.sh` on the server.
 */
router.post(
  '/update',
  handler(async (req, res) => {
    if (!SELF_UPDATE) {
      throw httpError(
        403,
        'self_update_disabled',
        'Aggiornamento dall’app non abilitato. Esegui ./scripts/update.sh sul server, oppure imposta SELF_UPDATE_ENABLED=true e riavvia.'
      );
    }
    if (!repoAvailable()) {
      throw httpError(500, 'no_repo_mount', 'Il repository non è montato nel container.');
    }

    const before = await git(['rev-parse', 'HEAD']);
    let pull;
    try {
      pull = await git(['pull', '--ff-only', 'origin', 'main'], { timeout: 60000 });
    } catch (err) {
      throw httpError(409, 'pull_failed', `git pull non riuscito: ${err.message}`);
    }
    const after = await git(['rev-parse', 'HEAD']);

    if (before === after) {
      return res.json({ updated: false, message: 'Già all’ultima versione.', shaShort: after.slice(0, 7) });
    }

    // Reinstall deps only if the lockfile changed in this pull.
    let deps = 'unchanged';
    try {
      const changed = await git(['diff', '--name-only', before, after]);
      if (/(^|\n)package(-lock)?\.json/.test(changed)) {
        deps = 'installing';
        await new Promise((resolve, reject) =>
          execFile(
            'npm',
            ['ci', '--omit=dev', '--no-audit', '--no-fund'],
            { cwd: '/app', timeout: 240000 },
            (e) => (e ? reject(e) : resolve())
          )
        );
        deps = 'installed';
      }
    } catch (err) {
      throw httpError(500, 'deps_failed', `Aggiornamento dipendenze non riuscito: ${err.message}`);
    }

    res.status(202).json({ updated: true, restarting: true, from: before.slice(0, 7), to: after.slice(0, 7), deps });

    // Give the response time to flush, then let compose restart us.
    setTimeout(() => process.exit(0), 400);
  })
);

module.exports = router;

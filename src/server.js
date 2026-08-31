'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { pool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { startBackupScheduler } = require('./backup/scheduler');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

// Set HTTPS_ENABLED=true only when the app is actually reached over TLS
// (directly or via an HTTPS reverse proxy). When false (the default), we must
// NOT emit HSTS or `upgrade-insecure-requests`, otherwise a plain-HTTP
// deployment (http://server:3010) has its own assets upgraded to https:// and
// fails to load — the page would hang on the loading screen.
const httpsEnabled = process.env.HTTPS_ENABLED === 'true';

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
};
// Only force-upgrade to HTTPS when we know the app is served over HTTPS.
if (httpsEnabled) cspDirectives.upgradeInsecureRequests = [];

app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: cspDirectives },
    hsts: httpsEnabled,
  })
);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/summary', require('./routes/summary'));
app.use('/api/backups', require('./routes/backups'));

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Static SPA
const publicDir = path.join(__dirname, '..', 'public');
// No build/hash step on assets, so revalidate every load (fast 304s via ETag)
// rather than risk serving a stale bundle after an update.
app.use(express.static(publicDir, { maxAge: 0, etag: true, index: false }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

async function start() {
  await migrate();
  startBackupScheduler();
  app.listen(PORT, () => console.log(`[soldi] listening on :${PORT}`));
}

start().catch((err) => {
  console.error('[soldi] failed to start', err);
  process.exit(1);
});

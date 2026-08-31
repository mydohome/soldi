'use strict';

require('dotenv').config();
const { pool } = require('../db/pool');
const { createBackup } = require('./backup-core');

(async () => {
  try {
    const label = process.argv[2] || 'manual';
    const dir = await createBackup({ label });
    console.log(`[backup] created ${dir}`);
    await pool.end();
  } catch (err) {
    console.error('[backup] failed', err);
    process.exit(1);
  }
})();

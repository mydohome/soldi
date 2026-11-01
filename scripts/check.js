'use strict';

/**
 * Lightweight smoke test: parse every source file and fail on a syntax error.
 * Backend files are checked as CommonJS, browser files under public/js as ES
 * modules. No dependencies, no database — safe to run anywhere, including CI.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'scripts')),
  ...walk(path.join(root, 'public', 'js')),
];

let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const isModule = rel.startsWith(path.join('public', 'js'));
  try {
    if (isModule) {
      // node --check has no per-file module flag; feed it on stdin as a module.
      execFileSync(process.execPath, ['--check', '--input-type=module'], {
        input: fs.readFileSync(file),
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } else {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    console.log(`  ok   ${rel}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${rel}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}

// Sanity-check the JSON files we ship.
for (const json of ['package.json', 'package-lock.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, json), 'utf8'));
    console.log(`  ok   ${json}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${json}: ${err.message}`);
  }
}

// Schema file must be present and non-trivial.
const schema = fs.readFileSync(path.join(root, 'src', 'db', 'schema.sql'), 'utf8');
if (!/CREATE TABLE IF NOT EXISTS transactions/.test(schema)) {
  failed++;
  console.error('  FAIL src/db/schema.sql: missing transactions table');
} else {
  console.log('  ok   src/db/schema.sql');
}

console.log(`\n${files.length + 3} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);

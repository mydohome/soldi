'use strict';

const readline = require('readline');

/** Chiede conferma da terminale. Bypassata da --yes o RESTORE_ASSUME_YES=true. */
async function confirm(question) {
  if (process.argv.includes('--yes') || process.env.RESTORE_ASSUME_YES === 'true') return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

module.exports = { confirm };

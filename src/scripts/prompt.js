'use strict';

const readline = require('readline');

/** Ask a question on the terminal. `silent` masks typed characters (passwords). */
function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    if (silent) {
      rl._writeToOutput = (str) => {
        if (muted) {
          // keep the prompt visible, mask everything the user types
          if (/[\r\n]/.test(str)) rl.output.write(str);
          else rl.output.write('*');
        } else {
          rl.output.write(str);
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    if (silent) muted = true;
  });
}

module.exports = { ask };

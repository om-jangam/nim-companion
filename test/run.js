'use strict';
/*
 * npm test - runs every *.test.js in this folder and reports a total.
 *
 * Tests that need the local model (Ollama) or the network skip themselves when
 * those are missing. NIM_SKIP_LIVE=1 skips them on purpose, for a fast run.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const only = process.argv[2];
const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js') && (!only || f.includes(only)))
  .sort();

let pass = 0, fail = 0, failedFiles = [];
const started = Date.now();

for (const f of files) {
  process.stdout.write('\n=== ' + f + ' ===\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 900000 });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out.split('\n').filter((l) => /FAIL|SKIP|passed,|Error/.test(l)).join('\n') + '\n');
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  if (m) { pass += Number(m[1]); fail += Number(m[2]); }
  if (r.status !== 0) { failedFiles.push(f); if (!m) fail++; }
}

console.log('\n' + '='.repeat(48));
console.log(files.length + ' files, ' + pass + ' passed, ' + fail + ' failed in ' +
            ((Date.now() - started) / 1000).toFixed(0) + 's');
if (failedFiles.length) console.log('failing: ' + failedFiles.join(', '));
process.exit(fail ? 1 : 0);

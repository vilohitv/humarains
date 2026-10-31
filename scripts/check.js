/** Syntax-checks every JavaScript file in the project (no test run, no database needed). */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0, count = 0;

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'public') walk(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    count++;
    const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    if (r.status !== 0) { failed++; console.error(`✗ ${path.relative(ROOT, full)}\n${r.stderr}`); }
  }
})(ROOT);

console.log(failed ? `${failed} of ${count} files have syntax errors.` : `✓ ${count} files OK`);
process.exit(failed ? 1 : 0);

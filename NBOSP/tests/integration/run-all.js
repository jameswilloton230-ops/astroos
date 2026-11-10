#!/usr/bin/env node
// Runs every *.suite.js in this directory in sequence and reports a summary.
// The integration suites are plain node scripts (they assert via console
// summaries + process exit codes), so they run outside vitest on purpose —
// vitest only picks up tests/**/*.test.js.
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const here = __dirname;
const nbospRoot = path.join(here, '..', '..');
const suites = fs.readdirSync(here).filter((f) => f.endsWith('.suite.js')).sort();

const results = [];
let failed = 0;
for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(here, suite)], {
    stdio: 'inherit',
    cwd: nbospRoot,
  });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  results.push([suite, ok]);
}

console.log('\n══════════ integration suites ══════════');
for (const [suite, ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}`);
console.log('═════════════════════════════════════════');
if (failed > 0) {
  console.log(`${failed}/${results.length} integration suite(s) failed`);
  process.exit(1);
}
console.log(`all ${results.length} integration suites passed`);

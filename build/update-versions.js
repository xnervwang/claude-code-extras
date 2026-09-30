// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Write the record of verified Claude Code builds. The only thing that writes it, so that the file always means the same
 * thing - see build/supported.js for what is recorded and why.
 *
 *   node build/update-versions.js        say what would change
 *   node build/update-versions.js -w     write it
 *
 * A build on this machine that the patch set does not fit is reported and left out of the record. That is not this
 * script's problem to solve: it means a rule needs a new shape, and writing a file that omits the build would hide it.
 */
const fs = require('fs');
const path = require('path');
const s = require('./supported');

const write = process.argv.slice(2).some((a) => a === '-w' || a === '--write');
const { verified, problems } = s.verifyHere();
const before = s.read();
const after = s.merge(before, verified);
const text = s.format(after);
const current = fs.existsSync(s.SUPPORTED_FILE) ? fs.readFileSync(s.SUPPORTED_FILE, 'utf8') : '';
const rel = path.relative(path.join(__dirname, '..'), s.SUPPORTED_FILE);

const here = Object.keys(verified);
console.log(here.length
  ? `verified on this machine: ${here.join(', ')}`
  : 'no Claude Code build on this machine could be verified');
const carried = Object.keys(after.claudeCode).filter((v) => !verified[v]);
if (carried.length) console.log(`carried over from the record, not installed here: ${carried.join(', ')}`);

for (const [version, list] of Object.entries(problems)) {
  console.log(`\n${version} is NOT supported by the current rules:`);
  for (const p of list) console.log('  ' + p);
}

if (text === current) {
  console.log(`\n${rel} is already up to date`);
  process.exit(Object.keys(problems).length ? 1 : 0);
}

if (!write) {
  console.log(`\n${rel} is out of date. Run: node build/update-versions.js -w`);
  process.exit(1);
}

fs.writeFileSync(s.SUPPORTED_FILE, text);
console.log(`\nwrote ${rel}`);
process.exit(Object.keys(problems).length ? 1 : 0);

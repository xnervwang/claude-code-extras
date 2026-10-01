// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Write the record of Claude Code builds this commit is verified to patch. The only thing that writes it, so that the
 * file always means the same thing - see build/supported.js for what is recorded.
 *
 *   node build/update-versions.js        say what would change, and what it would take to write it
 *   node build/update-versions.js -w     run the check suite and write the record if it passes
 *
 * NOTHING IS WRITTEN UNLESS THE WHOLE SUITE PASSES. A line in that file says this code works against that build, and
 * rules matching is not that claim: the rules can each match once while the injected script no longer parses, or a
 * patched file no longer carries its marker. The suite is what settles it, so it is the gate rather than a separate
 * courtesy, and the one command that writes the claim is the one that runs it.
 *
 * The suite is run WITHOUT the section that checks this very file. That is not a way around the gate - it is the only
 * order that terminates. That section fails when the record claims a build it cannot verify, which is exactly the state
 * this command exists to correct; leaving it in means the fix is blocked by the defect it fixes, with no way out but
 * editing the file by hand. Every other section applies in full.
 *
 * A build on this machine that the patch set does not fit is reported and the record is not written. It means a rule
 * needs a new shape, and recording the builds that did fit would quietly narrow what this commit claims while looking
 * like an ordinary update.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const s = require('./supported');

const ROOT = path.join(__dirname, '..');
const SUITE = path.join(ROOT, 'test', 'check.js');
const write = process.argv.slice(2).some((a) => a === '-w' || a === '--write');
const rel = path.relative(ROOT, s.SUPPORTED_FILE);

const { verified, problems } = s.verifyHere();
const text = s.format(s.record(verified));
const current = fs.existsSync(s.SUPPORTED_FILE) ? fs.readFileSync(s.SUPPORTED_FILE, 'utf8') : '';
const here = Object.keys(verified);

console.log(here.length
  ? `verified on this machine: ${here.join(', ')}`
  : 'no Claude Code build on this machine could be verified');
const dropped = Object.keys(s.read().claudeCode).filter((v) => !verified[v]);
if (dropped.length) {
  console.log(`recorded but not verifiable here, so no longer claimed: ${dropped.join(', ')}`);
  console.log(`  (what each earlier commit claimed stays in git: git log -S<version> -- ${rel})`);
}
for (const [version, list] of Object.entries(problems)) {
  console.log(`\n${version} is NOT supported by the current rules:`);
  for (const p of list) console.log('  ' + p);
}
if (Object.keys(problems).length) {
  console.log('\nnothing written: fix the rules first, or this commit would claim less than it should without saying so');
  process.exit(1);
}

if (text === current) {
  console.log(`\n${rel} is already up to date`);
  process.exit(0);
}
if (!write) {
  console.log(`\n${rel} is out of date. To write it: node build/update-versions.js -w`);
  process.exit(1);
}

console.log('\nrunning the check suite before claiming anything...');
const run = cp.spawnSync(process.execPath, [SUITE, '--without-version-record'], { cwd: ROOT, encoding: 'utf8' });
const tail = (run.stdout || '').trim().split('\n').slice(-1)[0] || '';
if (run.status !== 0) {
  // The failures themselves, since the point of printing them is that they have to be fixed before the claim is made.
  for (const line of (run.stdout || '').split('\n')) if (line.includes('FAIL')) console.log(line);
  console.log(`\n${tail}`);
  console.log(`nothing written: ${rel} would have claimed support this code does not have`);
  process.exit(1);
}
console.log('  ' + tail);
fs.writeFileSync(s.SUPPORTED_FILE, text);
console.log(`\nwrote ${rel}: ${here.join(', ') || 'nothing'}`);

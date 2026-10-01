// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which Claude Code builds this commit has been verified to patch, kept in the repository so that the answer can be
 * looked up per commit rather than remembered.
 *
 * The question this exists to answer is "which of our versions still works with the Claude Code I am stuck on", asked
 * months later by somebody who cannot upgrade. Nothing else in the repository can answer it: a rule that no longer fits
 * a build fails at patch time on the user's machine, so without a record the only way to find out is to install an old
 * Claude Code and try.
 *
 * A COMMIT CLAIMS ONLY WHAT WAS VERIFIED AGAINST ITS OWN CODE. The file holds the builds present on the machine at the
 * moment it was written, each of which had every rule run against it and had to match exactly once - the same test the
 * extension applies before it writes anything. A build that is not installed is left out, even if an earlier commit
 * verified it.
 *
 * That is the correction of an earlier design here, and the failure is worth keeping because it was silent. The file used
 * to carry builds forward: anything already recorded but missing from the machine was copied across untouched, on the
 * reasoning that upgrading Claude Code deletes the old bundle and dropping it would lose the only record of it. The
 * consequence was that regenerating produced identical bytes, so the check over this file always passed, and the claim
 * drifted with nothing reporting it - commit 551f105 changed the injected script while 2.1.283 and 2.1.284 were already
 * gone from the machine, and went on claiming to support both without either having been run against that code.
 *
 * The premise was also wrong. Losing the older build was never a risk: every commit that recorded one is still in git, so
 * `git log -S<version> -- supported-versions.json` finds the commits that claimed it and `git log -p` shows what each
 * claimed, which is exactly the lookup this file exists for. History already held what the current file was being
 * stretched to hold.
 *
 * Nothing is written until the whole check suite passes - see build/update-versions.js. A claim of support is a claim
 * that this code works against that build, which is what the suite establishes and what matching rules alone do not.
 *
 * WHAT KEEPS THIS HONEST is one equality the suite checks: the set recorded here equals the set this machine just
 * verified. Too many, and the commit claims a build nothing established. Too few, and an upgrade goes unrecorded for
 * ever - a record that is merely conservative never fails anything, so nothing would ever ask for it to be written
 * again. Both directions therefore fail.
 *
 * That equality can only be checked where the bundles are, which is not CI: a runner has no Claude Code installed, and
 * the section reports itself as skipped rather than passing. Enforcement is therefore local, and the place it reaches
 * whoever is working here is the suite itself - the first step of finishing any change in this repository, rather than
 * one more thing to remember.
 *
 * None of it belongs in the plugin shipped inside the .vsix. Those hooks run in every conversation on a user's machine,
 * and whether this repository's record is current is of no concern to anyone who is not working in this repository.
 *
 * Which alternative shape each build needed is recorded alongside it, for the rules that have more than one. That is
 * the part with real diagnostic value: it is how one sees at a glance that 2.1.285 needed a new shape while everything
 * before it shares one, and a diff against the previous commit says exactly what upstream changed under us.
 *
 * No timestamps. A file that changes on every run produces a diff on every commit, and a diff that is always there is
 * one nobody reads. This way an unchanged verification leaves no trace, and every diff means something moved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ADAPTERS = require('../src/adapters');
const { pickShape, shapesOf } = require('../src/edits');

const ROOT = path.join(__dirname, '..');
const SUPPORTED_FILE = path.join(ROOT, 'supported-versions.json');
/* Another patcher's banner: some other tool has claimed this file, so ours is not what is in there and the bundle tells
   us nothing about our own rules. Same shape the checks use - `/* NAME v1 *​/` on a line of its own. */
const FOREIGN_MARKER = /^\/\* [A-Z][A-Z0-9-]{3,} v\d+ \*\//m;
const VERSION_FROM_DIR = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/i;

/** Where VS Code keeps extensions, including the variant a remote server uses. */
function extensionsDirs() {
  const home = os.homedir();
  return [
    process.env.VSCODE_EXTENSIONS,
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode', 'extensions'),
  ].filter(Boolean);
}

/**
 * The unpatched source of one patch target, and where it came from.
 *
 * Our own backup first: once we have patched a file, the file itself is no longer evidence about upstream, and checking
 * our rules against our own output would pass no matter what upstream did. Null when neither is usable.
 */
function pristine(file, adapter) {
  for (const [p, from] of [[file + adapter.BACKUP_SUFFIX, 'our backup'], [file, 'the file itself']]) {
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (src.includes(adapter.ANY_MARK)) continue;
    const foreign = src.match(FOREIGN_MARKER);
    if (foreign) return { foreign: foreign[0].trim(), from };
    return { src, from };
  }
  return null;
}

/** Every Claude Code install on this machine as `{ version, dir }`, newest version last. */
function installs() {
  const out = new Map();
  for (const dir of Array.from(new Set(extensionsDirs()))) {
    for (const install of ADAPTERS[0].findInstalls(dir)) {
      const m = path.basename(install).match(VERSION_FROM_DIR);
      // A directory whose name carries no version cannot be recorded under one, and guessing would put a wrong claim
      // in the file. Only the checks, which work per directory, can say anything about it.
      if (m && !out.has(m[1])) out.set(m[1], install);
    }
  }
  return [...out.entries()].sort((a, b) => cmpVersion(a[0], b[0])).map(([version, dir]) => ({ version, dir }));
}

/** Semantic order, so 2.1.9 sorts before 2.1.10 rather than after it the way strings would. */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Run every rule against one bundle set and say whether the whole patch set fits.
 *
 * Returns `{ shapes, problems }`. `shapes` names the chosen alternative for each rule that has more than one, keyed
 * `"<target> / <rule>"`; rules with a single shape are left out, since there is nothing to choose and listing them
 * would bury the interesting lines. `problems` is empty when the build is supported.
 */
function verifyInstall(dir) {
  const shapes = {};
  const problems = [];
  for (const adapter of ADAPTERS) {
    const file = adapter.targetFile(dir);
    const p = pristine(file, adapter);
    if (!p) { problems.push(`${adapter.name}: no unpatched source available (patched, and no backup)`); continue; }
    if (p.foreign) { problems.push(`${adapter.name}: another patcher owns this file (${p.foreign})`); continue; }
    for (const edit of adapter.EDITS) {
      const picked = pickShape(p.src, edit);
      if (picked.error) { problems.push(`${adapter.name}: ${picked.error}`); continue; }
      if (shapesOf(edit).length > 1) {
        shapes[`${adapter.name} / ${edit.name}`] = picked.note || `shape ${picked.index + 1}`;
      }
    }
    const patched = adapter.patchSource(p.src);
    if (patched.error) problems.push(`${adapter.name}: ${patched.error}`);
  }
  return { shapes, problems };
}

/** What this machine can attest to: `{ verified: {version: {shapes}}, problems: {version: [...]} }`. */
function verifyHere() {
  const verified = {};
  const problems = {};
  for (const { version, dir } of installs()) {
    const r = verifyInstall(dir);
    if (r.problems.length) problems[version] = r.problems;
    else verified[version] = { shapes: r.shapes };
  }
  return { verified, problems };
}

const EMPTY = { claudeCode: {} };

/** The record as committed, or an empty one when there is none yet or it cannot be read. */
function read(file = SUPPORTED_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.claudeCode === 'object' && parsed.claudeCode) return { claudeCode: parsed.claudeCode };
  } catch (_) { /* absent or unreadable is the same as nothing recorded */ }
  return EMPTY;
}

/**
 * The record this machine's findings imply: what was verified here, and nothing else.
 *
 * There is deliberately no note of WHICH patch each build was verified against, though a draft of this had one. It would
 * carry no information: the recorded set is the installed set, and the check suite runs every rule against every
 * installed bundle on every run - so each build named here was verified against the code as it stands, by the same run
 * that is about to be committed. The one thing that has to hold is that this set and the verified set are equal, and
 * comparing the two says that directly.
 */
function record(verified) {
  const out = {};
  for (const v of Object.keys(verified).sort(cmpVersion)) out[v] = verified[v];
  return { claudeCode: out };
}

/* A trailing newline and two-space indent, so the file reads as a file rather than as one line, and so that an editor
   saving it does not produce a diff of its own. */
function format(record) {
  return JSON.stringify({
    comment: 'Claude Code builds THIS COMMIT was verified to patch, on the machine that wrote it. Written by'
      + ' build/update-versions.js once the whole check suite passes. A build absent from that machine is left out'
      + ' rather than carried forward, so for an older one use: git log -S<version> -- supported-versions.json.'
      + ' See build/supported.js.',
    claudeCode: record.claudeCode,
  }, null, 2) + '\n';
}

module.exports = {
  SUPPORTED_FILE, extensionsDirs, pristine, installs, cmpVersion,
  verifyInstall, verifyHere, read, record, format, FOREIGN_MARKER,
};

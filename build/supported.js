// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Which Claude Code builds this extension has been verified to patch, kept in the repository so that the answer can be
 * looked up per commit rather than remembered.
 *
 * The question this exists to answer is "which of our versions still works with the Claude Code I am stuck on", asked
 * months later by somebody who cannot upgrade. Nothing else in the repository can answer it: a rule that no longer fits
 * a build fails at patch time on the user's machine, so without a record the only way to find out is to install an old
 * Claude Code and try.
 *
 * WHAT IS RECORDED IS WHAT WAS VERIFIED, not what happened to be installed. Every rule is run against every bundle
 * found on this machine and each has to match exactly once, which is the same test the extension itself applies before
 * it writes anything - so a version reaching this file means the whole patch set really fitted that bundle. Recording
 * the installed version instead would record an accident of whoever committed.
 *
 * THE RECORD ONLY GROWS. A build that is in the file but not on this machine is carried over untouched. Anything else
 * would make the record a property of the committing machine: upgrading Claude Code deletes the old bundle, so a
 * regenerate-from-scratch would silently drop every older build the moment one person upgraded, and the file would
 * always claim support for exactly one version.
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
 * The record this machine's findings imply: everything already recorded, plus what was verified here.
 *
 * A version verified here replaces its old entry, because this run looked at the bundle and the old entry was written
 * by a run that may have looked at a different one. A version not present here is carried over as it stands - see the
 * note at the top of this file for why that is the whole point rather than laziness.
 */
function merge(existing, verified) {
  const out = {};
  const all = new Set([...Object.keys(existing.claudeCode || {}), ...Object.keys(verified)]);
  for (const v of [...all].sort(cmpVersion)) out[v] = verified[v] || existing.claudeCode[v];
  return { claudeCode: out };
}

/* A trailing newline and two-space indent, so the file reads as a file rather than as one line, and so that an editor
   saving it does not produce a diff of its own. */
function format(record) {
  return JSON.stringify({
    comment: 'Claude Code builds this extension has been verified to patch. Written by build/update-versions.js;'
      + ' see build/supported.js for what "verified" means and why entries are never removed.',
    claudeCode: record.claudeCode,
  }, null, 2) + '\n';
}

module.exports = {
  SUPPORTED_FILE, extensionsDirs, pristine, installs, cmpVersion,
  verifyInstall, verifyHere, read, merge, format, FOREIGN_MARKER,
};

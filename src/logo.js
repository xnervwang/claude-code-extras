// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/**
 * Third patch target: the tab icon Claude Code shows when a turn has finished and you have not looked yet.
 *
 * Claude Code keeps three copies of its own logo and picks between them by state - plain, pending, done. The pending one
 * carries a blue dot in the corner; the done one carries a dot in the logo's own colour, the same value as the fill of
 * the shape it sits on. So the badge that says "this conversation is waiting for you" is invisible, which is not a
 * matter of taste: it is the one of the three states you would act on.
 *
 * It is recoloured green rather than blue, even though blue is easier to see: blue already means pending. Painting done
 * blue too would make the two states that most need telling apart look the same. The green is the one the panel already
 * uses for a tool call that succeeded, so the extension says "finished" in one colour rather than two.
 *
 * Same discipline as the other two targets - match exactly once or write nothing, save the untouched original beside the
 * file, replace atomically, restore on uninstall. What differs is the check on the result: an SVG cannot be handed to a
 * JavaScript parser, so instead the output is proved to differ from the original in nothing but that one colour.
 */
const fs = require('fs');
const path = require('path');

const { applyEdits } = require('./edits');

const VERSION = 1;
const MARK = `<!-- CLAUDE-CODE-EXTRAS-LOGO v${VERSION} -->`;
const ANY_MARK = '<!-- CLAUDE-CODE-EXTRAS-LOGO v';
const BACKUP_SUFFIX = '.claude-code-extras-logo.bak';
const TMP_SUFFIX = '.claude-code-extras-logo.tmp';

/* The logo's own colour, and what the badge becomes. Both are written out here rather than read from the file, because
   the edit has to be able to say that it did not match - a build that renamed the colour is one to leave alone. */
const LOGO = '#D97757';
const DONE = '#74c991';

const EDITS = [
  /*
   * Anchored on a circle carrying the logo's colour, not on where that circle is. The file has two circles in it - the
   * badge and the hole punched in the mask beneath it - and only the badge is filled this way, so the shape is unique
   * without naming a position. Naming the position would make a build that nudged the badge by a pixel unsupported.
   */
  {
    name: 'done badge colour',
    re: new RegExp('(<circle\\b[^>]*\\bfill=")' + LOGO + '(")', 'g'),
    to: (m, before, after) => before + DONE + after,
  },
];

function logoFile(claudeExtensionPath) {
  return path.join(claudeExtensionPath, 'resources', 'claude-logo-done.svg');
}

/** Pure transform. Returns { out, chosen } or { error }. Never partially applies. */
function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'already patched' };
  const r = applyEdits(src, EDITS);
  if (r.error) return { error: r.error };
  const out = MARK + '\n' + r.out;
  /* What "it still works" means for a drawing. Undoing the marker and the colour has to give back the original exactly:
     that says the file is untouched apart from the one value, which is the whole of what this edit claims to do. A
     renderer cannot be asked here, and a check that only looked for the new colour would pass on a mangled file. */
  const undone = out.slice(MARK.length + 1).split(DONE).join(LOGO);
  if (undone !== src) return { error: 'patched icon differs from the original in more than the badge colour' };
  return { out, chosen: r.chosen };
}

/** 'patched' (this version), 'outdated' (another version of this patch), 'clean', 'missing'. */
function status(claudeExtensionPath) {
  const file = logoFile(claudeExtensionPath);
  if (!fs.existsSync(file)) return 'missing';
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) return 'patched';
  if (src.includes(ANY_MARK)) return 'outdated';
  return 'clean';
}

function writeAtomic(file, text) {
  const tmp = file + TMP_SUFFIX;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Apply (or upgrade) the icon patch. Returns { changed, liveChanged, message }. */
function apply(claudeExtensionPath) {
  const file = logoFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(claudeExtensionPath);
  if (state === 'missing') return { changed: false, liveChanged: false, message: `Claude Code's done icon not found at ${file}` };
  if (state === 'patched') return { changed: false, liveChanged: false, message: 'already patched' };
  let original;
  if (state === 'outdated') {
    if (!fs.existsSync(backup)) return { changed: false, liveChanged: false, message: 'an older icon patch is present but its backup is missing; reinstall Claude Code' };
    original = fs.readFileSync(backup, 'utf8');
  } else {
    original = fs.readFileSync(file, 'utf8');
  }
  const r = patchSource(original);
  if (r.error) return { changed: false, liveChanged: false, message: r.error };
  if (state === 'clean') fs.writeFileSync(backup, original);
  writeAtomic(file, r.out);
  return { changed: true, liveChanged: false, message: 'patched' };
}

/** Put the original icon back and remove the backup. Returns { changed, message }. */
function restore(claudeExtensionPath) {
  const file = logoFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  writeAtomic(file, original);
  fs.unlinkSync(backup);
  return { changed: true, message: 'restored' };
}

module.exports = {
  id: 'anthropic.claude-code', name: 'Claude Code done icon',
  VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS, LOGO, DONE,
  patchSource, status, apply, restore, logoFile, targetFile: logoFile,
  findInstalls: require('./webview').findInstalls,
};

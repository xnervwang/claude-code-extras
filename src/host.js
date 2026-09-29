// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/**
 * Second patch target: the Claude Code extension host bundle.
 *
 * The host already parses each session's createdAt out of the transcript head, but the object it
 * posts to the webview drops that field, so the session list has no way to show when a session was
 * started. This adapter adds the one field back.
 *
 * Same discipline as the webview patcher: the edit must match exactly once, the result must parse,
 * the untouched original is saved next to the file first, and the replacement is atomic. A build
 * whose shape does not match is left alone with a warning rather than patched on a guess.
 *
 * The host bundle is far riskier to patch than the webview: a broken file means the extension fails
 * to activate. Hence a single, minimal edit and a separate marker and backup, so a failure here
 * cannot disturb the webview patch.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { applyEdits } = require('./edits');

const VERSION = 4;
const MARK = `/* CLAUDE-CODE-EXTRAS-HOST v${VERSION} */`;
const ANY_MARK = '/* CLAUDE-CODE-EXTRAS-HOST v';
const BACKUP_SUFFIX = '.claude-code-extras-host.bak';
const TMP_SUFFIX = '.claude-code-extras-host.tmp';

const EDITS = [
  {
    name: 'session list transport',
    re: /return\{id:([\w$]+)\.sessionId,archived:/g,
    to: (m, u) => `return{id:${u}.sessionId,createdAt:${u}.createdAt,archived:`,
  },
  /*
   * Which conversation is in front of the reader.
   *
   * Nothing outside this bundle can answer that. Every conversation opens with one view type and one starting title, so
   * the tabs cannot be told apart by kind, and the lock files name a window's folders but no session. The host does
   * know: it keeps the active session in a field of its own. So the field is what this reads, and it reaches this
   * extension through a global the two share - both run in one extension host process.
   *
   * The field's declaration becomes a pair of accessors, which is one edit that catches every write to it. Hooking a
   * single place that happens to use the value would catch one moment out of eleven, and the moment a conversation is
   * switched to need not be that one.
   *
   * The alternative considered and dropped: read the title off the focused tab and match it against a plan. That joins
   * on text written for people to look at, which drifts, collides between conversations and lags behind a rename, and
   * it needs a fallback for each of those. This is an id or nothing.
   */
  {
    name: 'active conversation id',
    re: /;activeSessionId;/g,
    to: () => ';_cceChat;get activeSessionId(){return this._cceChat}'
      + 'set activeSessionId(v){this._cceChat=v;globalThis.__cceActiveChat=v;'
      + 'try{globalThis.__cceChatHook&&globalThis.__cceChatHook(v)}catch(e){}}',
  },
];

function hostFile(claudeExtensionPath) { return path.join(claudeExtensionPath, 'extension.js'); }

/** Pure transform. Returns { out, chosen } or { error }. Never partially applies. */
function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'already patched' };
  const r = applyEdits(src, EDITS);
  if (r.error) return { error: r.error };
  const out = MARK + '\n' + r.out;
  try { new vm.Script(out, { filename: 'extension.js' }); }
  catch (err) { return { error: `patched host code does not parse: ${err.message}` }; }
  return { out, chosen: r.chosen };
}

/** 'patched' (this version), 'outdated' (another version of this patch), 'clean', 'missing'. */
function status(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
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

/** Apply (or upgrade) the host patch. Returns { changed, liveChanged, message }. */
function apply(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(claudeExtensionPath);
  if (state === 'missing') return { changed: false, liveChanged: false, message: `Claude Code host bundle not found at ${file}` };
  if (state === 'patched') return { changed: false, liveChanged: false, message: 'already patched' };
  let original;
  if (state === 'outdated') {
    if (!fs.existsSync(backup)) return { changed: false, liveChanged: false, message: 'an older host patch is present but its backup is missing; reinstall Claude Code' };
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

/** Put the original host bundle back and remove the backup. Returns { changed, message }. */
function restore(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  writeAtomic(file, original);
  fs.unlinkSync(backup);
  return { changed: true, message: 'restored' };
}

module.exports = {
  id: 'anthropic.claude-code', name: 'Claude Code host',
  VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS,
  patchSource, status, apply, restore, hostFile, targetFile: hostFile,
  findInstalls: require('./webview').findInstalls,
};

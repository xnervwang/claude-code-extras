// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The text color of each conversation in the session list, set from a row's right-click menu
 * (src/page/84-session-colors.js draws them).
 *
 * The colors are kept in one file in this extension's global storage, on the machine that holds the transcripts, and
 * every window reads and writes that same file, as with the pins (src/sessionpins.js). Each write reads the file again
 * just before it and replaces it whole.
 *
 * The names are Claude Code's /color names. Claude Code records a conversation's /color in its transcript, but
 * nothing in the VS Code panel reads that record, and a running conversation writes its own value back over one added
 * from outside.
 */
const fs = require('fs');
const path = require('path');
const { SESSION, writeAtomic } = require('./claude-files');

const FILE = 'session-colors.json';
const NAMES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

/** The colors on file, as { session ID: name } in session ID order. Invalid entries are skipped. */
function read(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { raw = null; }
  const from = raw && raw.colors && typeof raw.colors === 'object' ? raw.colors : {};
  const colors = {};
  for (const id of Object.keys(from).sort()) {
    if (SESSION.test(id) && NAMES.includes(from[id])) colors[id] = from[id];
  }
  return colors;
}

/* Sorted, so that windows writing the same colors write the same bytes. */
function write(file, colors) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = {};
  for (const id of Object.keys(colors).sort()) sorted[id] = colors[id];
  writeAtomic(file, JSON.stringify({ colors: sorted }, null, 1) + '\n');
}

/**
 * Set the color of these conversations, or clear it with null. Other IDs are ignored. Returns whether the file changed.
 */
function setColor(file, ids, name) {
  if (name !== null && !NAMES.includes(name)) return false;
  const want = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && SESSION.test(id));
  if (!want.length) return false;
  const colors = read(file);
  let changed = false;
  for (const id of want) {
    if (name === null) {
      if (Object.prototype.hasOwnProperty.call(colors, id)) { delete colors[id]; changed = true; }
    } else if (colors[id] !== name) { colors[id] = name; changed = true; }
  }
  if (changed) write(file, colors);
  return changed;
}

/**
 * Drop the colors of conversations whose transcripts are gone. `live` is the set of session IDs still on disk; when it
 * is not a Set, because the transcripts could not all be read, nothing is dropped.
 */
function prune(file, live) {
  if (!(live instanceof Set)) return false;
  const colors = read(file);
  const gone = Object.keys(colors).filter((id) => !live.has(id));
  if (!gone.length) return false;
  for (const id of gone) delete colors[id];
  write(file, colors);
  return true;
}

module.exports = { FILE, NAMES, read, write, setColor, prune };

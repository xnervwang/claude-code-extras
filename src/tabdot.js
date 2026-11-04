// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The dot on the Claude logo of a Claude Code tab. Claude Code puts a blue dot there while it waits for you and an
 * orange one when a turn finished and you have not looked yet, and nothing while a turn runs. This adds a green dot
 * for that, the colour of the running dot in the session list. It is Claude Code's waiting icon with the dot's fill
 * changed, read from the running build, so this extension ships no copy of the logo.
 *
 * The patched host asks for an icon each time it picks the tab's icon, with the icon key it picked ('pending', 'done'
 * or 'plain') and the session state ('idle', 'running' or 'waiting_input').
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./claude-files');

// Claude Code's own icon for each state, in its resources folder.
const FILES = { idle: 'claude-logo.svg', waiting: 'claude-logo-pending.svg', unread: 'claude-logo-done.svg' };
const BLUE = /fill="#3b82f6"/gi;
const GREEN = '#89d185';
// A title can still end in one of these, written by an older build of this extension when the state went after it.
const MARKS = [' \u{1F539}', ' \u{1F538}', ' \u{1F4D7}', ' \u{1F7E2}', ' \u{1F535}', ' \u{1F7E0}', ' \u25CF'];

function stateOf(icon, run) {
  if (icon === 'pending') return 'waiting';
  if (run === 'running') return 'running';
  return icon === 'done' ? 'unread' : 'idle';
}

/** The waiting icon with its blue dot made green; '' if it has no single blue fill. */
function greenDot(svg) {
  const text = String(svg || '');
  return (text.match(BLUE) || []).length === 1 ? text.replace(BLUE, `fill="${GREEN}"`) : '';
}

/**
 * Claude Code's own three icons in `resources`, plus the green one, written once into `dir` under a name hashed from
 * its contents. Null if any is missing; `cache` remembers the result per folder.
 */
function iconsFor(resources, dir, cache) {
  if (cache && cache.has(resources)) return cache.get(resources);
  let icons = null;
  try {
    const own = Object.fromEntries(Object.entries(FILES).map(([s, name]) => [s, path.join(resources, name)]));
    const green = greenDot(fs.readFileSync(own.waiting, 'utf8'));
    if (green && fs.existsSync(own.idle) && fs.existsSync(own.unread)) {
      const tag = crypto.createHash('sha256').update(green).digest('hex').slice(0, 12);
      const file = path.join(dir, `${tag}-running.svg`);
      let have = '';
      try { have = fs.readFileSync(file, 'utf8'); } catch (_) { /* not written yet */ }
      if (have !== green) {
        fs.mkdirSync(dir, { recursive: true });
        writeAtomic(file, green);
      }
      icons = { ...own, running: file };
    }
  } catch (_) { icons = null; }
  if (cache) cache.set(resources, icons);
  return icons;
}

function withoutMark(title) {
  const text = String(title == null ? '' : title);
  const mark = MARKS.find((m) => text.endsWith(m));
  return mark ? text.slice(0, -mark.length) : text;
}

module.exports = { FILES, GREEN, MARKS, stateOf, greenDot, iconsFor, withoutMark };

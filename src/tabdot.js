// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The dot on the Claude logo of a Claude Code tab. Claude Code draws none while a turn runs, and its dot for a finished
 * turn is orange, which is lost on the orange logo, so here the first is green and the second red; the blue dot for
 * waiting on you stays. The session list uses the same green and red (src/webview.js).
 *
 * The three icons are Claude Code's waiting icon from the running build with a larger dot in each colour, so this
 * extension ships no copy of the logo.
 *
 * The patched host asks for an icon each time it picks the tab's icon, with the icon key it picked ('pending', 'done'
 * or 'plain') and the session state ('idle', 'running' or 'waiting_input').
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./claude-files');

// Claude Code's own icons, in its resources folder.
const FILES = { idle: 'claude-logo.svg', waiting: 'claude-logo-pending.svg' };
const BLUE = '#3b82f6';
const GREEN = '#22c55e';
const RED = '#ef4444';
// The waiting icon's dot, and the circle its mask cuts out of the logo around it.
const DOT = /<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)" fill="#3b82f6"\/>/gi;
const CUT = /<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)" fill="black"\/>/gi;
// How much larger the dot is drawn, in the icon's 24-unit box. The cut keeps its size, so it takes no more of the
// logo's rays than Claude Code's own, and the gap round the dot narrows instead.
const GROW = 1;
const BOX = 24;
// A title can still end in one of these, written by an older build of this extension when the state went after it.
const MARKS = [' \u{1F539}', ' \u{1F538}', ' \u{1F4D7}', ' \u{1F7E2}', ' \u{1F535}', ' \u{1F7E0}', ' \u25CF'];

function stateOf(icon, run) {
  if (icon === 'pending') return 'waiting';
  if (run === 'running') return 'running';
  return icon === 'done' ? 'unread' : 'idle';
}

/**
 * The waiting icon with a larger dot in `color`, moved in so it stays inside the box; '' if the icon does not have
 * exactly one blue dot and one cut circle.
 */
function withDot(svg, color) {
  const text = String(svg || '');
  const dots = [...text.matchAll(DOT)], cuts = [...text.matchAll(CUT)];
  if (dots.length !== 1 || cuts.length !== 1) return '';
  const r = Number(dots[0][1]) + GROW, c = BOX - r;
  return text.replace(DOT, `<circle cx="${c}" cy="${r}" r="${r}" fill="${color}"/>`)
    .replace(CUT, `<circle cx="${c}" cy="${r}" r="${cuts[0][1]}" fill="black"/>`);
}

/** Paths by state: Claude Code's idle icon, and the three dotted ones, written into `dir` the first time. */
function iconsFor(resources, dir, cache) {
  if (cache && cache.has(resources)) return cache.get(resources);
  let icons = null;
  try {
    const own = Object.fromEntries(Object.entries(FILES).map(([s, name]) => [s, path.join(resources, name)]));
    const waiting = fs.readFileSync(own.waiting, 'utf8');
    const made = { waiting: withDot(waiting, BLUE), running: withDot(waiting, GREEN), unread: withDot(waiting, RED) };
    if (Object.values(made).every(Boolean) && fs.existsSync(own.idle)) {
      icons = { idle: own.idle };
      for (const [s, svg] of Object.entries(made)) {
        const file = path.join(dir, `${crypto.createHash('sha256').update(svg).digest('hex').slice(0, 12)}-${s}.svg`);
        let have = '';
        try { have = fs.readFileSync(file, 'utf8'); } catch (_) { /* not written yet */ }
        if (have !== svg) {
          fs.mkdirSync(dir, { recursive: true });
          writeAtomic(file, svg);
        }
        icons[s] = file;
      }
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

module.exports = { FILES, BLUE, GREEN, RED, GROW, MARKS, stateOf, withDot, iconsFor, withoutMark };

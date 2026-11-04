// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Claude logo on a Claude Code tab, in the colour of the conversation's dot in the session list: blue while it
 * waits for you, green while a turn runs, orange when it finished and you have not looked yet, light orange otherwise.
 *
 * Claude Code's own icons put a small dot on the orange logo, and its dot for a finished turn is that same orange, so
 * it is hard to see. These icons are the plain logo with its fill changed. The logo is read from the running Claude
 * Code build, beside the icon the host has just set, so this extension ships no copy of it.
 *
 * The patched host calls this each time it picks the tab's icon, with the icon key it picked ('pending', 'done' or
 * 'plain') and the session state ('idle', 'running' or 'waiting_input').
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./claude-files');

const LOGO = 'claude-logo.svg';
const ORANGE = '#d97757';
const COLORS = { waiting: '#3b82f6', running: '#89d185', unread: ORANGE, idle: ORANGE };
const IDLE_OPACITY = '0.5';
const FILL = /fill="#d97757"/gi;
// A title can still end in one of these, written by an older build of this extension when the state went after it.
const MARKS = [' \u{1F539}', ' \u{1F538}', ' \u{1F4D7}', ' \u{1F7E2}', ' \u{1F535}', ' \u{1F7E0}', ' \u25CF'];

function stateOf(icon, run) {
  if (icon === 'pending') return 'waiting';
  if (run === 'running') return 'running';
  return icon === 'done' ? 'unread' : 'idle';
}

/** The logo with its fill set for `state`; '' if it has no single orange fill to change. */
function recolor(svg, state) {
  const text = String(svg || '');
  if (!COLORS[state] || (text.match(FILL) || []).length !== 1) return '';
  const fill = `fill="${COLORS[state]}"` + (state === 'idle' ? ` fill-opacity="${IDLE_OPACITY}"` : '');
  return text.replace(FILL, fill);
}

/**
 * Writes the four icons for `logo` into `dir` and returns their paths by state. File names carry a hash of the logo
 * and the colours, so a changed logo gets new files. Null when the logo cannot be read or has no single orange fill;
 * `cache` keeps the answer per logo.
 */
function iconsFor(logo, dir, cache) {
  if (cache && cache.has(logo)) return cache.get(logo);
  let icons = null;
  try {
    const svg = fs.readFileSync(logo, 'utf8');
    const made = Object.fromEntries(Object.keys(COLORS).map((s) => [s, recolor(svg, s)]));
    if (Object.values(made).every(Boolean)) {
      const tag = crypto.createHash('sha256').update(svg).update(JSON.stringify([COLORS, IDLE_OPACITY])).digest('hex').slice(0, 12);
      fs.mkdirSync(dir, { recursive: true });
      icons = {};
      for (const [s, text] of Object.entries(made)) {
        const file = path.join(dir, `${tag}-${s}.svg`);
        let have = '';
        try { have = fs.readFileSync(file, 'utf8'); } catch (_) { /* not written yet */ }
        if (have !== text) writeAtomic(file, text);
        icons[s] = file;
      }
    }
  } catch (_) { icons = null; }
  if (cache) cache.set(logo, icons);
  return icons;
}

function withoutMark(title) {
  const text = String(title == null ? '' : title);
  const mark = MARKS.find((m) => text.endsWith(m));
  return mark ? text.slice(0, -mark.length) : text;
}

module.exports = { LOGO, COLORS, IDLE_OPACITY, MARKS, stateOf, recolor, iconsFor, withoutMark };

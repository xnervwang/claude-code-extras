// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Claude Code tabs closed in a workspace, most recent first, for the Recently closed section at the end of the
 * session list.
 *
 * Claude Code notes each tab closed in a window, ten at most, for its own reopen-closed command, and forgets them on a
 * reload. The patched host hands each closing to this extension (src/host.js), which keeps them per workspace across
 * reloads. Nothing more is decided here: the page leaves out the ones open again and shows as many as the setting says.
 */
const { SESSION } = require('./claude-files');
/* More than anyone would ask to see, so the setting can be raised without losing what was closed before. */
const KEEP = 50;
const KEY = 'cce.recentClosed';

const valid = (e) => e && typeof e.id === 'string' && SESSION.test(e.id) && Number.isFinite(e.at);

/** The list with `id` closed at `now`: first, once. */
function record(list, id, now = Date.now()) {
  const old = Array.isArray(list) ? list.filter(valid) : [];
  if (typeof id !== 'string' || !SESSION.test(id)) return old.slice(0, KEEP);
  return [{ id, at: now }, ...old.filter((e) => e.id !== id)].slice(0, KEEP);
}

/** What the page is handed: how many to show, and the closed conversations, most recent first. */
function pageData(list, max) {
  const n = Number.isInteger(max) && max > 0 ? Math.min(max, KEEP) : 0;
  return { max: n, ids: (Array.isArray(list) ? list.filter(valid) : []).map((e) => e.id) };
}

module.exports = { record, pageData, KEEP, KEY };

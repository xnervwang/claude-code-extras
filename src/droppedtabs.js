// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code tabs that VS Code did not bring back after a restart or a reload.
 *
 * VS Code saves a window's tabs every minute or so and at quit, and keeps a webview tab only if the extension that
 * restores tabs of that kind is running at that moment - except a tab it restored itself at the last start, which it
 * always keeps. A Claude Code tab opened since the last start is therefore dropped whenever the window saves while it
 * has lost the dev desktop: after a sleep or a network change longer than the server waits for it to reconnect, or
 * while the window shows that it cannot reconnect. Nothing reports it; the tab is simply missing next time.
 *
 * Claude Code keeps its own record of the conversations in its tabs, written while it runs, and reads it as it starts.
 * The patched host hands over that record as it was read (src/host.js), before Claude Code drops the entries whose tab
 * is missing. A conversation in it that is not shown anywhere now, and whose tab title is not among the Claude Code tabs
 * VS Code did restore, is one VS Code dropped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* More than this at once is more likely a record gone wrong than tabs a person had open. */
const LIMIT = 20;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Whether a conversation still has a transcript, in any project folder. */
function transcriptExists(id, projects = path.join(claudeDir(), 'projects')) {
  let dirs;
  try { dirs = fs.readdirSync(projects); } catch (_) { return false; }
  return dirs.some((d) => { try { return fs.statSync(path.join(projects, d, id + '.jsonl')).isFile(); } catch (_) { return false; } });
}

/*
 * The record's entries to reopen, in its order. An entry Claude Code only guessed from a title is left out, and so is
 * one whose conversation is shown now, whose title matches a Claude Code tab VS Code restored (each tab answers for one
 * entry), or whose transcript is gone.
 */
function find({ record, shown, labels, strip = (t) => t, exists = transcriptExists, limit = LIMIT }) {
  const open = new Set(Array.isArray(shown) ? shown : []);
  const left = new Map();
  for (const label of Array.isArray(labels) ? labels : []) {
    const t = strip(label);
    left.set(t, (left.get(t) || 0) + 1);
  }
  const out = [], seen = new Set();
  for (const e of Array.isArray(record) ? record : []) {
    if (!e || typeof e.sessionId !== 'string' || !SESSION.test(e.sessionId) || e.inferred === true) continue;
    if (seen.has(e.sessionId) || open.has(e.sessionId)) continue;
    seen.add(e.sessionId);
    const t = strip(typeof e.title === 'string' ? e.title : '');
    if (left.get(t) > 0) { left.set(t, left.get(t) - 1); continue; }
    if (!exists(e.sessionId)) continue;
    out.push({ sessionId: e.sessionId, title: t, fullEditor: e.fullEditor === true });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { find, transcriptExists, LIMIT };

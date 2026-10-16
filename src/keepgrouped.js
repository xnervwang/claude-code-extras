// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversations put into a group of the session list, kept from Claude Code's transcript cleanup.
 *
 * The cleanup deletes a transcript whose file has not been modified for cleanupPeriodDays (30 by default), and the tool
 * outputs stored beside it under <session>/tool-results by the same test, file by file. The modification time is the
 * whole test: nothing in a transcript or beside it exempts one, short of being a Claude Desktop session. The session
 * list's groups are how a person says a conversation matters - they already keep it from being archived - and the
 * cleanup does not read them.
 *
 * So a grouped conversation's files are given a later modification time before they reach that age: a file older than
 * the cutoff plus a margin is set to exactly that. As old as it can be while still kept, because the session list
 * orders by the same time and shows it as when the conversation was last active.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 86400000;
/* The cleanup's own default when no settings file sets one. */
const DEFAULT_DAYS = 30;
/* How long this extension may go without running before a grouped file is lost: a window has to have been open at least
   once in that time. Half the retention when that is shorter, so a short retention still leaves room. */
const MARGIN_DAYS = 14;
const GROUPS_PREFIX = 'sessionGroups:';
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/* The folder Claude Code reads managed settings from on this platform. */
function managedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/** Every session id in any group, read from Claude Code's own state - the lists of every folder, not only this one's. */
function groupedIds(state) {
  const ids = new Set();
  if (!state || typeof state.keys !== 'function' || typeof state.get !== 'function') return ids;
  for (const key of state.keys()) {
    if (typeof key !== 'string' || !key.startsWith(GROUPS_PREFIX)) continue;
    const groups = state.get(key);
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.sessionIds)) continue;
      for (const id of g.sessionIds) if (typeof id === 'string' && SESSION.test(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * The retention to keep ahead of: the smallest cleanupPeriodDays among the user's settings and the managed settings,
 * which is never later than the one the cleanup applies. A project's own settings can set a smaller one still, and the
 * cleanup run from that project applies it to every project; those are not read here.
 */
function retentionDays(files = [path.join(claudeDir(), 'settings.json'), path.join(managedDir(), 'managed-settings.json')]) {
  let days = null;
  for (const f of files) {
    let v;
    try { v = JSON.parse(fs.readFileSync(f, 'utf8')).cleanupPeriodDays; } catch (_) { continue; }
    if (Number.isInteger(v) && v >= 1 && (days === null || v < days)) days = v;
  }
  return days === null ? DEFAULT_DAYS : days;
}

/**
 * Gives each grouped conversation's transcript, and each tool output stored for it, a later modification time once it
 * is older than the cutoff plus the margin. Returns counts for the log.
 */
async function keep({ ids, days, projectsDir = path.join(claudeDir(), 'projects'), now = Date.now() }) {
  const out = { grouped: ids.size, found: 0, touched: 0, errors: 0 };
  if (!ids.size) return out;
  const floor = new Date(now - days * DAY + Math.min(MARGIN_DAYS, days / 2) * DAY);
  const fsp = fs.promises;
  const refresh = async (file) => {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || !(st.mtime < floor)) return;
      await fsp.utimes(file, st.atime, floor);
      out.touched++;
    } catch (_) { out.errors++; }
  };
  /* The cleanup goes one folder deep under tool-results, so this does too. */
  const refreshTree = async (dir, depth) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) await refreshTree(p, depth - 1); } else await refresh(p);
    }
  };
  let projects;
  try { projects = await fsp.readdir(projectsDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir, p.name);
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { out.errors++; continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || !ids.has(n.slice(0, -6))) continue;
      out.found++;
      await refresh(path.join(dir, n));
      await refreshTree(path.join(dir, n.slice(0, -6), 'tool-results'), 1);
    }
  }
  return out;
}

module.exports = { groupedIds, retentionDays, keep, managedDir, MARGIN_DAYS, DAY };

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Conversations pinned in the session list, kept from Claude Code's transcript cleanup.
 *
 * Claude Code's cleanup deletes a transcript not modified for cleanupPeriodDays (30 by default), and each tool output
 * under <session>/tool-results by the same test; only Claude Desktop sessions are exempt. So a pinned conversation's
 * files get a later modification time before they reach that age: a file older than the cutoff plus a margin is set to
 * a day past it. The time is kept as old as possible because the session list sorts by it and shows it as the last
 * activity; the extra day keeps later passes, which run every half hour in every window, from moving it again. Each
 * move rewrites the pin record, which also rewrites the stylesheet every panel reloads.
 *
 * The pins are kept in one file in this extension's global storage, on the machine that holds the transcripts, and every
 * window reads and writes that same file. Each write reads the file again just before it and replaces it whole, so two
 * windows lose nothing to each other short of writing within the same instant.
 *
 * The first time a transcript's time is moved, the time it had and the time it was given are recorded, so the list can
 * still show when the conversation was really last active. Once the file is newer than the time it was given, somebody
 * wrote to it, its own time is the true one again, and the record goes.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir, projectsDir, projectFolders, SESSION, writeAtomic } = require('./claude-files');

const DAY = 86400000;
/* The cleanup's own default when no settings file sets one. */
const DEFAULT_DAYS = 30;
/* How long this extension may go without running before a pinned file is lost, unless the setting says otherwise: a
   window has to have been open at least once in that time. Half the retention when that is shorter, so a short retention
   still leaves room and a long margin never puts a file's time at or past now. */
const MARGIN_DAYS = 14;
/* Offset past the floor for a moved file: a day, or a quarter of the retention when that is shorter, so the file stays
   well clear of now. */
const STEP_MS = DAY;
/*
 * A file whose modification time is more than this past both its recorded time and the time a pass would set now has
 * been written to, so its own time is real again. Passes in any window set times within minutes of each other, so an
 * hour separates the two. Comparing with only the recorded time, a pass another window made between this one reading
 * the record and checking the file would look like a write and lose the real time; comparing with only the pass time
 * would do the same to every moved file once a shorter margin or a longer retention moves that time back.
 */
const WRITTEN_MS = 60 * 60 * 1000;
const FILE = 'session-pins.json';

/* The folder Claude Code reads managed settings from on this platform. */
function managedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
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

/** How many days short of the cleanup a pinned file is kept, given the margin asked for. */
function marginDays(days, wanted = MARGIN_DAYS) {
  return Math.min(Number.isFinite(wanted) && wanted >= 1 ? wanted : MARGIN_DAYS, days / 2);
}

const validRecord = (r) => r && typeof r === 'object' && Number.isFinite(r.real) && Number.isFinite(r.set);

/** The pins as stored, or none when the file is missing or unreadable. Anything malformed in it is dropped. */
function read(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { raw = null; }
  const pinned = [];
  const times = {};
  if (raw && Array.isArray(raw.pinned)) {
    for (const id of raw.pinned) if (typeof id === 'string' && SESSION.test(id) && !pinned.includes(id)) pinned.push(id);
  }
  if (raw && raw.times && typeof raw.times === 'object') {
    for (const [id, r] of Object.entries(raw.times)) {
      if (SESSION.test(id) && validRecord(r)) times[id] = { real: r.real, set: r.set };
    }
  }
  return { pinned, times };
}

/* Replaced whole, so a reader in another window sees the old pins or the new ones. */
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ pinned: data.pinned, times: data.times }, null, 1) + '\n');
}

/**
 * Pin or unpin one conversation. Unpinning leaves the time its files were given, and the record of the real one: the
 * list keeps showing when it was really last active until somebody writes to it. Returns whether anything changed.
 */
function setPinned(file, id, on) {
  if (typeof id !== 'string' || !SESSION.test(id)) return false;
  const data = read(file);
  if (data.pinned.includes(id) === !!on) return false;
  data.pinned = on ? data.pinned.concat(id) : data.pinned.filter((x) => x !== id);
  write(file, data);
  return true;
}

/**
 * Move pinned conversations' transcripts and tool outputs older than the cutoff plus the margin to a later modification
 * time, and compute the updated record of real times. Newer files are left alone, so back-to-back passes change
 * nothing.
 *
 * Touches nothing in the pins file: the caller folds `updates` and `gone` into what the file holds by then. `gone` is
 * only filled when every project folder could be read and at least one transcript was found in them, so a folder that
 * fails to list, or a projects folder that is not the one Claude Code writes to, cannot unpin anything.
 */
async function keep({ ids, times = {}, days, margin = MARGIN_DAYS, projectsDir: projects = projectsDir(), now = Date.now() }) {
  const out = { pinned: ids.size, found: 0, touched: 0, errors: 0, updates: {}, gone: [] };
  const recorded = Object.keys(times);
  if (!ids.size && !recorded.length) return out;
  const floor = now - days * DAY + marginDays(days, margin) * DAY;
  const given = new Date(floor + Math.min(STEP_MS, days * DAY / 4));
  const fsp = fs.promises;
  const refresh = async (file) => {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || !(st.mtimeMs < floor)) return null;
      await fsp.utimes(file, st.atime, given);
      out.touched++;
      return st;
    } catch (_) { out.errors++; return null; }
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
  const seen = new Set();
  let complete = true, transcripts = 0;
  const folders = projectFolders(projects);
  if (!folders) return out;
  for (const dir of folders) {
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { out.errors++; complete = false; continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      transcripts++;
      const id = n.slice(0, -6);
      const pinned = ids.has(id);
      if (!pinned && !times[id]) continue;
      seen.add(id);
      const file = path.join(dir, n);
      let rec = times[id] || null;
      if (rec) {
        let st;
        try { st = await fsp.stat(file); } catch (_) { out.errors++; continue; }
        if (st.mtimeMs > Math.max(rec.set, given.getTime()) + WRITTEN_MS) { out.updates[id] = null; rec = null; }
      }
      if (!pinned) continue;
      out.found++;
      const before = await refresh(file);
      if (before) out.updates[id] = { real: rec ? rec.real : before.mtimeMs, set: given.getTime() };
      await refreshTree(path.join(dir, id, 'tool-results'), 1);
    }
  }
  if (complete && transcripts) {
    for (const id of new Set([...ids, ...recorded])) if (!seen.has(id)) out.gone.push(id);
  }
  return out;
}

/** Fold what a pass found into the pins file as it is now. Returns whether the file changed. */
function applyPass(file, pass) {
  const data = read(file);
  let changed = false;
  for (const [id, rec] of Object.entries(pass.updates || {})) {
    const was = data.times[id];
    if (rec === null) { if (was) { delete data.times[id]; changed = true; } continue; }
    if (!was || was.real !== rec.real || was.set !== rec.set) { data.times[id] = rec; changed = true; }
  }
  for (const id of pass.gone || []) {
    if (data.pinned.includes(id)) { data.pinned = data.pinned.filter((x) => x !== id); changed = true; }
    if (data.times[id]) { delete data.times[id]; changed = true; }
  }
  if (changed) write(file, data);
  return changed;
}

/**
 * What the page is handed: the pinned ids, each recorded [real, given] time pair, and the margin in days. Sorted, since
 * every window writes it into the same stylesheet and has to produce the same bytes.
 */
function pageData(data, days, margin = MARGIN_DAYS) {
  const times = {};
  for (const id of Object.keys(data.times).sort()) times[id] = [Math.round(data.times[id].real), Math.round(data.times[id].set)];
  return [data.pinned.slice().sort(), times, marginDays(days, margin)];
}

module.exports = {
  retentionDays, marginDays, keep, applyPass, read, write, setPinned, pageData, managedDir,
  FILE, SESSION, MARGIN_DAYS, STEP_MS, WRITTEN_MS, DAY,
};

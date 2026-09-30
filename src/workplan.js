// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan: what each conversation still has to do, read from a file the conversation itself maintains.
 *
 * One file per conversation, in the data directory the platform gives the companion Claude Code plugin:
 *
 *   ~/.claude/plugins/data/agent-work-plan-claude-code-extras/<session id>.json
 *
 * That location is not a choice of ours - it is what a plugin is given, created when the plugin is installed. The two
 * nearby places are both wrong for it: ~/.claude/scratch is one person's own convention and means nothing on another
 * machine, and ~/.claude/projects is Claude Code's own namespace, where a file of ours would sooner or later collide
 * with something official.
 *
 * A session id is unique across every project on a machine, so it is the whole name and no grouping directory is needed.
 *
 * The ordinary read is of one such file - the conversation in front of the reader, named by the host itself. Reading the
 * whole directory instead is kept only for the case where nothing can say which conversation that is: it put every
 * conversation on the machine into every window at once, and its cost grew with how many conversations had ever existed.
 *
 * Nothing here writes those files. The shape below is the whole contract between the two halves:
 *
 *   { "title": "optional name for this conversation",
 *     "nodes": [ { "title": "...", "state": "discussing|todo|parked|done|dropped",
 *                  "note": "optional, read in the dialog and the hover rather than on the row",
 *                  "detail": "optional, several lines; what the row cannot say in its width",
 *                  "opened": "optional ISO 8601; when this row was added",
 *                  "closed": "optional ISO 8601; when it reached done or dropped",
 *                  "children": [ ... ] } ] }
 *
 * A child is something that has to be finished before its parent can be, whether that was planned or discovered on the
 * way. Nesting means exactly that and nothing else - not the order topics came up in.
 *
 * Reading is forgiving about a file that is absent or half-written, since it is written by another process and may be
 * caught mid-write. It is NOT forgiving quietly: a file that exists and cannot be parsed comes back as an entry with an
 * error on it, so the view can say so. A plan that silently shows nothing is indistinguishable from no work left.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Where every plugin keeps its own data, and the name of ours. The two are kept apart because a file watcher needs a
   base that already exists, and ours is created when the plugin is installed - which may be after this extension has
   started. The name is taken from the side that decides it rather than written out again here: it is derived from the
   plugin and marketplace names, so a copy of it here would be a second thing to remember to change. */
const DATA_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'data');
const PLAN_DIR = require('./plugin-install').DATA_DIR;
/* A conversation's file is named by its session id and nothing else, so anything else in that directory belongs to
   something else and is left alone. */
const PLAN_FILE = /^[0-9a-f][0-9a-f-]{7,}\.json$/i;
/* The Stop hook offers once, per conversation, to start a plan where none exists, and remembers having offered by
   leaving one of these behind. It outlives the conversation the same way a plan does, so it is swept the same way -
   otherwise the only trace of a conversation that declined would accumulate here for ever. */
const OFFER_FILE = /^[0-9a-f][0-9a-f-]{7,}\.offered$/i;
const STATES = ['discussing', 'todo', 'doing', 'parked', 'done', 'dropped'];
/* Depth and count are bounded because the file is written by another process: a cycle turned into JSON, or a runaway
   generator, would otherwise be rendered forever. Both are far above any plan a person reads. */
const MAX_DEPTH = 8;
const MAX_NODES = 2000;
/*
 * How much of a description this view will show, in lines as well as characters - thirty short lines are as unreadable
 * as one long paragraph, so a character count alone would not hold.
 *
 * It is a real limit rather than a safety valve, and there is deliberately no roomier view to escape into. A description
 * is what the next person needs in order to pick the task up; somewhere comfortable to write at length is an invitation
 * to write the history of the task instead, and a plan of histories is one nobody reads. The file keeps whatever was
 * cut, so nothing is lost - it simply is not made pleasant.
 */
const MAX_DETAIL_LINES = 12;
const MAX_DETAIL_CHARS = 900;

function planDir() {
  return path.join(DATA_ROOT, PLAN_DIR);
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* Where the limit bites it says so, and says it is the description that is at fault rather than the view: a description
   that stopped mid-sentence with nothing marking the cut reads as one that was written that way. */
function detail(v) {
  const s = text(v, MAX_DETAIL_CHARS * 4);
  const lines = s.split('\n');
  let out = lines.slice(0, MAX_DETAIL_LINES).join('\n');
  let cut = lines.length > MAX_DETAIL_LINES;
  if (out.length > MAX_DETAIL_CHARS) {
    out = out.slice(0, MAX_DETAIL_CHARS);
    cut = true;
  }
  if (!cut) return out;
  return out.replace(/\s+$/, '')
    + `\n\n[too long: a description is kept to ${MAX_DETAIL_LINES} lines and ${MAX_DETAIL_CHARS} characters.`
    + ' The rest is in the file, and belongs somewhere other than a task.]';
}

/* A timestamp as milliseconds, or 0 for absent and for anything unparseable. Zero rather than null so a row that
   carries no time and a row that carries a broken one read the same to the view: in both cases there is nothing true to
   show, and drawing "Invalid Date" on a row would be worse than drawing nothing. */
function when(v) {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : 0;
}

/** One node and its children, keeping only the fields the view draws. Returns null for anything unusable. */
function node(raw, depth, budget) {
  if (!raw || typeof raw !== 'object' || budget.left <= 0) return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  budget.left--;
  const state = STATES.includes(raw.state) ? raw.state : 'todo';
  const children = [];
  if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const c = node(child, depth + 1, budget);
      if (c) children.push(c);
    }
  }
  return {
    title, state, note: text(raw.note, 120), detail: detail(raw.detail),
    opened: when(raw.opened), closed: when(raw.closed), children,
  };
}

/** Every work plan on this machine, most recently written first. */
/** One plan, or null when there is no readable file for that session. */
function readOne(session) {
  const file = path.join(planDir(), session + '.json');
  let st, body;
  try {
    st = fs.statSync(file);
    if (!st.isFile() || !st.size) return null;
    body = fs.readFileSync(file, 'utf8');
  } catch (_) { return null; }
  const entry = { session, file, mtime: st.mtimeMs, title: '', label: session.slice(0, 8), nodes: [], error: '' };
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) {
    // Half-written is the ordinary case for a file another process is replacing, and it fixes itself on the next read;
    // anything else is a real defect in what wrote it and has to be visible.
    entry.error = e.message;
    return entry;
  }
  entry.title = text(parsed && parsed.title, 120);
  // What a conversation is called in the view, decided here so that no two places can disagree about it.
  if (entry.title) entry.label = entry.title;
  const budget = { left: MAX_NODES };
  if (parsed && Array.isArray(parsed.nodes)) {
    for (const raw of parsed.nodes) {
      const n = node(raw, 0, budget);
      if (n) entry.nodes.push(n);
    }
  }
  return entry;
}

/**
 * The plan of one conversation, named by its session.
 *
 * This is the whole of the ordinary case: the view shows the conversation in front of the reader, so it reads that one
 * file and no other. Reading the directory instead put every conversation on the machine into every window - the same
 * content in each, none of it the one being looked at - and made the work grow with how many conversations exist.
 */
function readPlan(session) {
  if (!session) return [];
  const one = readOne(session);
  return one ? [one] : [];
}

/**
 * Every plan on the machine, most recently written first.
 *
 * Only for the case where nothing can say which conversation is in front of the reader - a Claude Code build this
 * extension could not patch. Listing them is honest there; picking one would not be.
 */
function readPlans() {
  const dir = planDir();
  let names;
  // Absent until the plugin is installed, which is ordinary rather than an error.
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!PLAN_FILE.test(name)) continue;
    const one = readOne(name.replace(/\.json$/i, ''));
    if (one) out.push(one);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/*
 * Where Claude Code keeps its transcripts: one directory per starting directory, and inside it one file per conversation
 * named by the same session id a plan is named by.
 *
 * Only that one level is read. Deeper down are the transcripts of sub-agents, which are not conversations - reading them
 * as though they were would count sessions that never had a plan, and a recursive walk costs a thousand files more.
 */
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
/* A plan younger than this is left alone whatever the transcripts say. Its real job is not to wait longer - a transcript
   survives months of silence before Claude Code removes it - but to be certain that nothing still being written is ever
   touched, whatever went wrong with the reading below. */
const SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every session id that still has a transcript, or null when that could not be established.
 *
 * Null rather than an empty set, because the two mean opposite things and only one of them is safe: an unreadable or
 * empty transcript directory would make every plan on the machine look abandoned, and deleting all of them is exactly
 * the accident this returns null to prevent. A machine really holding no conversations also holds no plans, so nothing
 * is lost by refusing that case too.
 */
function liveSessions(projects = PROJECTS) {
  let dirs;
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch (_) { return null; }
  const live = new Set();
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try { names = fs.readdirSync(path.join(projects, d.name)); } catch (_) { continue; }
    for (const n of names) if (n.endsWith('.jsonl')) live.add(n.slice(0, -6));
  }
  return live.size ? live : null;
}

/**
 * Delete the plans of conversations that no longer exist. Returns what happened, for the log.
 *
 * A conversation whose transcript is gone can never be resumed, so its plan is a file nothing can reach: not this view,
 * which reads only the conversation in front of the reader, and not Claude Code. Left alone they only accumulate - at the
 * rate this machine starts conversations, thousands within a year.
 *
 * It deletes rather than moving them aside. An archive was the first shape of this and it was the wrong one: it has no
 * bound, so the files it saves from deletion are the same files somebody has to deal with later.
 */
function sweepOrphans(opts = {}) {
  const now = opts.now || Date.now();
  const dir = opts.dir || planDir();
  const live = liveSessions(opts.projects || PROJECTS);
  if (!live) return { deleted: 0, kept: 0, why: 'no transcripts could be read, so nothing was treated as abandoned' };
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return { deleted: 0, kept: 0, why: '' }; }
  let deleted = 0, kept = 0;
  for (const name of names) {
    if (!PLAN_FILE.test(name) && !OFFER_FILE.test(name)) continue;
    if (live.has(name.replace(/\.(json|offered)$/i, ''))) { kept++; continue; }
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (now - st.mtimeMs < SETTLED_MS) { kept++; continue; }
    // Already gone means another window got here first, which is the ordinary outcome of two of them starting on one
    // day rather than a fault: several extension hosts share this directory and nothing locks it.
    try { fs.unlinkSync(file); deleted++; }
    catch (e) { if (e.code !== 'ENOENT') kept++; }
  }
  return { deleted, kept, why: '' };
}

/** The states that mean a row still needs something done to it. */
const OPEN_STATES = ['discussing', 'todo', 'doing', 'parked'];

/**
 * The same rows with the unfinished ones first, each group keeping the order it had.
 *
 * A plan only grows: rows are added at the end and closed where they sit, so in the file's own order the few that still
 * need doing end up scattered among the many that are done - and a row added an hour ago sinks towards the middle as
 * later ones are added and closed after it. Reading "what is left" then means going through everything.
 *
 * Nothing is sorted within a group, so no row moves relative to others of its own kind: this separates the two and
 * changes nothing else. It is a matter of drawing only - the file is untouched, which is what keeps a hand edit
 * predictable, at the cost that the drawn order is no longer the file's order.
 */
function openFirst(items, stateOf = (n) => n && n.state) {
  const rows = items || [];
  const isOpen = (n) => OPEN_STATES.includes(stateOf(n));
  const open = rows.filter(isOpen);
  if (!open.length || open.length === rows.length) return rows;
  return open.concat(rows.filter((n) => !isOpen(n)));
}

/** Open counts, which is what the view puts in its title so the shape of the work is legible without expanding it. */
function countOpen(nodes, acc = { discussing: 0, todo: 0, parked: 0, done: 0, dropped: 0 }) {
  for (const n of nodes || []) {
    acc[n.state] = (acc[n.state] || 0) + 1;
    countOpen(n.children, acc);
  }
  return acc;
}

module.exports = {
  readPlan, readPlans, countOpen, planDir, liveSessions, sweepOrphans, openFirst,
  DATA_ROOT, PLAN_DIR, PLAN_FILE, OFFER_FILE, PROJECTS, SETTLED_MS, OPEN_STATES,
  STATES, MAX_DEPTH, MAX_NODES, MAX_DETAIL_LINES, MAX_DETAIL_CHARS,
};

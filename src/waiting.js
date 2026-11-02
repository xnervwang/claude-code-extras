// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Permission prompts and work plan questions waiting for the user, in the conversations started inside one of the
 * window's workspace folders:
 *
 *   - a row of a conversation's work plan that waits on the user (waitingOn "user"), with the question it asks;
 *   - a conversation Claude Code reports as waiting (status "waiting": a permission prompt, input it needs).
 *
 * `claude --bg` sessions are left out. Their questions go through the conversation that started them.
 *
 * The conversations come from `claude agents --json`, which Claude Code documents as the supported way for a script to
 * read session state. Its records are per process, and one conversation can be held by two processes at once - two
 * windows that both opened it - each under its own name, so they are merged by session id before anything is counted.
 *
 * Only the plans of those running conversations are read, so the cost follows how many conversations are open rather
 * than how many have ever existed.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { transcriptOf } = require('./claude-files');

/* Waits older than this go into the collapsed group at the bottom, so a month-old question does not sit above one
   asked a minute ago. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const AGENTS_TIMEOUT_MS = 15000;
/* The end of a transcript, where Claude Code appends the conversation's title again every turn. */
const TAIL_BYTES = 256 * 1024;

/** The records `claude agents --json` printed, or null when they cannot be read. */
function parseAgents(stdout) {
  let list;
  try { list = JSON.parse(String(stdout || '')); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;
  return list.filter((r) => r && typeof r === 'object' && typeof r.sessionId === 'string' && r.sessionId);
}

/** Run `claude agents --json` with the given binary. Resolves to { records, error }; records is null on failure. */
function listAgents(bin, run = cp.execFile) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ records: null, error: 'Claude Code\'s command line was not found' }); return; }
    run(bin, ['agents', '--json'], { timeout: AGENTS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const records = parseAgents(stdout);
        if (records) { resolve({ records, error: '' }); return; }
        const said = String(stderr || '').trim().split('\n').pop() || (err && err.message) || 'it printed no list';
        resolve({ records: null, error: '`claude agents --json`: ' + said });
      });
  });
}

/* Claude Code's default name for a conversation: the folder name and two hex digits. */
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function isDefaultName(name, cwd) {
  const m = /^(.*)-[0-9a-f]{2}$/.exec(String(name || ''));
  return !!m && slug(m[1]) === slug(path.basename(String(cwd || '')));
}

/**
 * The records merged into one per conversation. A conversation is waiting if any process holding it is, and keeps the
 * name somebody chose over a default one.
 */
function merge(records) {
  const by = new Map();
  for (const r of records || []) {
    if (!r || typeof r.sessionId !== 'string' || !r.sessionId) continue;
    let s = by.get(r.sessionId);
    if (!s) {
      s = { sessionId: r.sessionId, id: '', kind: '', cwd: '', name: '', waitingFor: '', processes: 0 };
      by.set(r.sessionId, s);
    }
    s.processes++;
    if (!s.id && typeof r.id === 'string') s.id = r.id;
    if (r.kind === 'background') s.kind = 'background';
    else if (!s.kind && typeof r.kind === 'string') s.kind = r.kind;
    if (!s.cwd && typeof r.cwd === 'string') s.cwd = r.cwd;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (name && (!s.name || (isDefaultName(s.name, s.cwd) && !isDefaultName(name, s.cwd)))) s.name = name;
    if (r.status === 'waiting') s.waitingFor = String(r.waitingFor || '').trim() || s.waitingFor || 'input';
  }
  return by;
}

/* So that /home/x and /local/home/x match when one is a symbolic link to the other. */
const realPath = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); } };
const caseOf = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;

/** Drops background sessions, and sessions started outside `folders`. */
function inFolders(sessions, folders) {
  const roots = (folders || []).filter(Boolean).map((f) => caseOf(realPath(f)));
  const out = new Map();
  for (const [id, s] of sessions) {
    if (s.kind === 'background' || !s.cwd) continue;
    const cwd = caseOf(realPath(s.cwd));
    const under = (root) => {
      const rel = path.relative(root, cwd);
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    };
    if (roots.some(under)) out.set(id, s);
  }
  return out;
}

/**
 * The titles a transcript carries near its end: the one the user gave, and the one Claude Code generated. Claude Code
 * writes both again every turn, so the last few hundred kilobytes hold the current ones however long the file is.
 */
function transcriptTitles(file) {
  const out = { custom: '', ai: '' };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !(out.custom && out.ai); i--) {
      const l = lines[i];
      if (!out.custom && l.includes('"type":"custom-title"')) {
        try { out.custom = String(JSON.parse(l).customTitle || '').trim(); } catch (_) { /* cut at the start of the tail */ }
      } else if (!out.ai && l.includes('"type":"ai-title"')) {
        try { out.ai = String(JSON.parse(l).aiTitle || '').trim(); } catch (_) { /* cut at the start of the tail */ }
      }
    }
  } catch (_) { /* no transcript yet, or unreadable: the other names stand in */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  return out;
}

/** The rows of a plan that wait on the user, each with the number shown in front of it. */
function planQuestions(nodes, prefix = '', out = []) {
  (nodes || []).forEach((n, i) => {
    const num = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.waitingOn === 'user' && (n.state === 'waiting' || n.state === 'discussing')) {
      out.push({ num, title: n.title, question: n.question || n.title, since: n.since || 0, state: n.state });
    }
    planQuestions(n.children, num, out);
  });
  return out;
}

const OPEN = ['discussing', 'todo', 'doing', 'waiting', 'parked'];
const firstOpen = (nodes) => (nodes || []).find((n) => OPEN.includes(n.state));

const ORDER = { prompt: 0, question: 1 };

/**
 * Everything waiting on the reader, grouped by conversation, with the waits older than STALE_MS set apart.
 *
 * `sessions` is merge()'s map. `readPlan(sessionId)` gives a plan as src/workplan.js reads it, or null. `titles(session)`
 * gives { custom, ai } for its transcript, and `since(session)` when it last wrote to it, in milliseconds or 0.
 */
function collect({ sessions, readPlan, titles, since, now = Date.now() }) {
  const groups = [];
  for (const s of sessions.values()) {
    const items = [];
    if (s.waitingFor) {
      items.push({ kind: 'prompt', text: s.waitingFor.charAt(0).toUpperCase() + s.waitingFor.slice(1), since: since(s) });
    }
    const plan = readPlan(s.sessionId);
    for (const q of planQuestions(plan && plan.nodes)) {
      items.push({ kind: 'question', text: q.question, row: q.num, rowTitle: q.title, since: q.since });
    }
    if (!items.length) continue;
    const t = titles(s);
    const named = s.name && !isDefaultName(s.name, s.cwd) ? s.name : '';
    const top = plan && firstOpen(plan.nodes);
    const title = t.custom || named || t.ai || (plan && plan.title) || (top && top.title) || s.name || s.id || s.sessionId;
    for (const it of items) it.stale = !!it.since && now - it.since > STALE_MS;
    const fresh = items.filter((it) => !it.stale), stale = items.filter((it) => it.stale);
    const base = { sessionId: s.sessionId, id: s.id, kind: s.kind, cwd: s.cwd, title };
    if (fresh.length) groups.push(Object.assign({ stale: false, items: sortItems(fresh) }, base));
    if (stale.length) groups.push(Object.assign({ stale: true, items: sortItems(stale) }, base));
  }
  const oldest = (g) => Math.min(...g.items.map((it) => it.since || now));
  const urgent = (g) => g.items.some((it) => it.kind === 'prompt');
  groups.sort((a, b) => (urgent(b) - urgent(a)) || (oldest(a) - oldest(b)));
  const fresh = groups.filter((g) => !g.stale), stale = groups.filter((g) => g.stale);
  return { fresh, stale, count: fresh.reduce((n, g) => n + g.items.length, 0) };
}

function sortItems(items) {
  return items.slice().sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || ((a.since || Infinity) - (b.since || Infinity)));
}

/**
 * Transcript lookups, kept between calls: a transcript's path, and the titles near its end, which are read again only
 * when the file has changed.
 */
function reader() {
  const paths = new Map(), seen = new Map();
  const fileOf = (sessionId) => {
    const known = paths.get(sessionId);
    if (known && fs.existsSync(known)) return known;
    const found = transcriptOf(sessionId) || '';
    if (found) paths.set(sessionId, found);
    return found;
  };
  const stat = (file) => { try { return fs.statSync(file); } catch (_) { return null; } };
  return {
    titles(s) {
      const file = fileOf(s.sessionId), st = file && stat(file);
      if (!st) return { custom: '', ai: '' };
      const key = st.size + ':' + st.mtimeMs, hit = seen.get(file);
      if (hit && hit.key === key) return hit.titles;
      const titles = transcriptTitles(file);
      seen.set(file, { key, titles });
      return titles;
    },
    /* Claude Code does not report when a wait began. A waiting session stops writing its transcript, so the transcript's
       modification time stands in for it. */
    since(s) {
      const file = fileOf(s.sessionId), st = file && stat(file);
      return st ? st.mtimeMs : 0;
    },
  };
}

module.exports = {
  parseAgents, listAgents, isDefaultName, merge, inFolders, transcriptTitles, planQuestions, collect, reader, STALE_MS,
};

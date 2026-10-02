// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The `claude --bg` sessions a conversation started, for the panel's agent map.
 *
 * A detached session's own record names nobody but itself, so who launched it is read from the other side: the Bash call
 * that started it printed `backgrounded · <id>` into the launching conversation's transcript - a fixed template in the
 * CLI, followed by the attach, logs and stop hints. This host reads that from the transcript of the conversation in front
 * of the reader, and writes what it found to a small file beside that conversation's plan.
 *
 * Those files are the shared state, not each host's memory. Every window builds the stylesheet from all of them, so two
 * windows looking at different conversations still write the same bytes; building it from what one window had scanned
 * would differ between windows, and the stylesheet is one file they all write - which is how settings once flickered.
 *
 * Reading is incremental. A transcript only grows, so the file records how far it was read and each pass reads what was
 * added since; the first pass over a large conversation reads all of it once. Only whole lines are consumed, because the
 * last one may still be being written.
 *
 * A detached session is never opened from here. The panel launches Claude on whatever conversation it opens, so opening
 * one that a daemon is still writing would put a second process on it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE = path.join(os.homedir(), '.claude');
const JOBS = path.join(CLAUDE, 'jobs');
const PROJECTS = path.join(CLAUDE, 'projects');
const SUFFIX = '.background';
const LINK_FILE = /^[0-9a-f][0-9a-f-]{7,}\.background$/i;
const SESSION = /^[0-9a-f][0-9a-f-]{7,}$/i;
const SHORT_ID = /^[0-9a-f]{8}$/;
/* The CLI's own words, middle dot and all, at the start of a line. When the output went to a terminal the id is wrapped
   in colour codes. */
const MARK = Buffer.from('backgrounded · ', 'utf8');
const ID_AFTER = /^backgrounded · (?:\x1b\[[0-9;]*m)*([0-9a-f]{8})(?![0-9a-f])/gm;
/* The flag that starts one, found in the command a tool result answers. */
const BG_FLAG = Buffer.from('--bg', 'utf8');
const CHUNK = 8 << 20;
/* The stylesheet carries all of this to every panel on every change, so the caps are about its size, not about how
   many sessions anyone starts. */
const MAX_SESSIONS = 10;
const MAX_PER_SESSION = 20;
const MAX_ENTRIES = 40;
/* How far a scan may get ahead of what is on disk before the position is written down. It is only a starting point for
   the next window or the next start, so it does not have to be exact - only not so stale that a restart reads it all. */
const PERSIST_EVERY = 1 << 20;

function planDir() { return require('./workplan').planDir(); }

const textOf = (b) => (typeof b.content === 'string' ? b.content
  : Array.isArray(b.content) ? b.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('') : '');

/*
 * One transcript line, read for launches. Every condition below has been met on its own by something that was not one.
 *
 * The output has to answer a command that ran `--bg`: a command that printed an earlier launch back - a grep over
 * another transcript, say - produced the very same line, at the start of it, for an id that was real and still had a
 * record, so nothing in the text could tell the two apart. The words have to open a line, which keeps out a launch
 * quoted in passing; be followed by exactly eight hex digits, which keeps out a document describing the format; and
 * name a session that has a record. The CLI's hints after the id are not required: a launch whose output was cut short
 * has none, and that is an ordinary launch.
 *
 * `ran` carries the commands across lines and passes, since a call and its result are separate rows.
 */
function readLine(line, ran, jobs, seen) {
  let row;
  try { row = JSON.parse(line); } catch (_) { return; }
  const blocks = row && row.message && Array.isArray(row.message.content) ? row.message.content : [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_use' && b.input && typeof b.input.command === 'string' && b.input.command.includes('--bg')) {
      ran.add(b.id);
      if (ran.size > 500) ran.delete(ran.values().next().value);
      continue;
    }
    if (b.type !== 'tool_result' || !ran.has(b.tool_use_id)) continue;
    const text = textOf(b);
    ID_AFTER.lastIndex = 0;
    let m;
    while ((m = ID_AFTER.exec(text))) {
      if (!seen.has(m[1]) && fs.existsSync(path.join(jobs, m[1], 'state.json'))) seen.add(m[1]);
    }
  }
}

/* Session ids are unique across every project on a machine, so the transcript is found by name, once. */
const where = new Map();
function transcriptOf(session, projects = PROJECTS) {
  const known = where.get(session);
  if (known && fs.existsSync(known)) return known;
  let dirs;
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch (_) { return ''; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(projects, d.name, session + '.jsonl');
    if (fs.existsSync(file)) { where.set(session, file); return file; }
  }
  return '';
}

function readLink(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === 'string' && SHORT_ID.test(x)) : [];
    const scannedTo = typeof d.scannedTo === 'number' && d.scannedTo >= 0 ? d.scannedTo : 0;
    return { ids, scannedTo };
  } catch (_) {
    return { ids: [], scannedTo: 0 };
  }
}

/* Written whole and renamed into place, so another window never reads half of it. */
function writeLink(file, link) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(link) + '\n');
  fs.renameSync(tmp, file);
}

/* What this host has found per conversation, kept so that a write which lost a race with another window's write puts
   back what the other one did not know about, the next time this host writes. */
const known = new Map();
const commands = new Map();
const busy = new Map();

/**
 * Read what one conversation's transcript has added since last time. Resolves to how many sessions were new.
 *
 * Only one pass per conversation runs at a time; a second request while one is under way gets the same promise.
 */
function scan(session, opts = {}) {
  if (!SESSION.test(String(session || ''))) return Promise.resolve({ added: 0, scannedTo: 0 });
  if (busy.has(session)) return busy.get(session);
  const run = scanOnce(session, opts).finally(() => busy.delete(session));
  busy.set(session, run);
  return run;
}

async function scanOnce(session, opts) {
  const dir = opts.dir || planDir();
  const jobs = opts.jobs || JOBS;
  const transcript = opts.transcript || transcriptOf(session, opts.projects || PROJECTS);
  if (!transcript) return { added: 0, scannedTo: 0 };
  const file = path.join(dir, session + SUFFIX);
  const link = readLink(file);
  let size;
  try { size = (await fs.promises.stat(transcript)).size; } catch (_) { return { added: 0, scannedTo: 0 }; }
  // A position past the end means the transcript was replaced rather than appended to, so it is read again in full.
  const from = link.scannedTo <= size ? link.scannedTo : 0;
  const seen = new Set(link.ids);
  for (const id of known.get(session) || []) seen.add(id);
  if (!commands.has(session)) commands.set(session, new Set());
  const ran = commands.get(session);
  let consumed = from;
  if (from < size) {
    const fh = await fs.promises.open(transcript, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - from));
      let pos = from, carry = Buffer.alloc(0);
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (!bytesRead) break;
        const start = pos - carry.length;
        pos += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const last = data.lastIndexOf(0x0a);
        if (last === -1) { carry = Buffer.from(data); continue; }
        // Only the lines that hold one of the two needles are parsed, in file order, so that a call is seen before
        // the result that answers it.
        const starts = new Set();
        for (const needle of [BG_FLAG, MARK]) {
          let at = 0;
          while ((at = data.indexOf(needle, at)) !== -1 && at < last) {
            starts.add(data.lastIndexOf(0x0a, at) + 1);
            at = data.indexOf(0x0a, at) + 1;
          }
        }
        for (const ls of [...starts].sort((a, b) => a - b)) {
          readLine(data.subarray(ls, data.indexOf(0x0a, ls)).toString('utf8'), ran, jobs, seen);
        }
        consumed = start + last + 1;
        carry = Buffer.from(data.subarray(last + 1));
      }
    } finally {
      await fh.close();
    }
  }
  const ids = [...seen];
  known.set(session, ids);
  const added = ids.filter((id) => !link.ids.includes(id)).length;
  /* No file is made for a conversation that started nothing: one per conversation looked at would be clutter, and the
     price of not having one is a single read of its transcript when a window next starts. */
  const exists = fs.existsSync(file);
  if (ids.length && (added || !exists || consumed - link.scannedTo >= PERSIST_EVERY)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeLink(file, { ids, scannedTo: consumed });
    } catch (_) { /* the next pass writes it */ }
  }
  return { added, scannedTo: consumed };
}

/* A state file is rewritten by the daemon while it runs, so a read can land on half of one. Then the last whole reading
   stands in for it rather than the session disappearing from the list for a refresh. */
const lastGood = new Map();
const CONTRACT = /^\s*<!--[\s\S]*?-->\s*/;
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const when = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return isFinite(t) ? t : null;
};

function readState(id, jobs = JOBS) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.join(jobs, id, 'state.json'), 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') { lastGood.delete(id); return null; }
    return lastGood.get(id) || null;
  }
  if (!d || typeof d !== 'object') return lastGood.get(id) || null;
  const entry = {
    id,
    name: clip(d.name, 80),
    state: clip(d.state, 20),
    detail: clip(d.detail, 160),
    needs: clip(d.needs, 300),
    result: clip(d.output && typeof d.output === 'object' ? d.output.result : '', 400),
    // A task written to the conventions here opens with a comment block saying what the document is for; the task
    // itself is what comes after it.
    task: clip(String(typeof d.intent === 'string' ? d.intent : '').replace(CONTRACT, '').trim(), 300),
    tokens: typeof d.tokens === 'number' && isFinite(d.tokens) ? d.tokens : null,
    startedAt: when(d.createdAt),
    endedAt: when(d.lastTerminalAt) || when(d.firstTerminalAt),
  };
  lastGood.set(id, entry);
  return entry;
}

/**
 * Every recorded session, trimmed to what the panel shows, for the stylesheet.
 *
 * Ordered by the link files' own modification times, which every window reads the same - so the order, and through the
 * caps the membership, do not depend on which window is asking.
 */
function collect(opts = {}) {
  const dir = opts.dir || planDir();
  const jobs = opts.jobs || JOBS;
  let names;
  try { names = fs.readdirSync(dir).filter((n) => LINK_FILE.test(n)); } catch (_) { return []; }
  const files = [];
  for (const n of names) {
    try { files.push({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }); } catch (_) { /* gone meanwhile */ }
  }
  files.sort((a, b) => b.t - a.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  const out = [];
  for (const { n } of files.slice(0, MAX_SESSIONS)) {
    const session = n.slice(0, -SUFFIX.length);
    for (const id of readLink(path.join(dir, n)).ids.slice(-MAX_PER_SESSION)) {
      const entry = readState(id, jobs);
      if (entry) out.push(Object.assign({ session }, entry));
      if (out.length >= MAX_ENTRIES) return out;
    }
  }
  return out;
}

module.exports = {
  scan, collect, readState, transcriptOf,
  SUFFIX, LINK_FILE, MAX_SESSIONS, MAX_PER_SESSION, MAX_ENTRIES,
};

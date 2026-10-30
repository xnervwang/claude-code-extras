// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Where Claude Code keeps what this extension reads beside it, and how a file that only grows is read.
 *
 * Several parts of the extension need the same few answers: where Claude Code's own directory is, what a session id
 * looks like, which project folder holds a conversation's transcript, which conversations still have one. Each is
 * answered here once. Written out in each part they drift apart - one honouring CLAUDE_CONFIG_DIR and another not, one
 * walk skipping a folder it cannot read where another refuses to go on - and nothing reports it.
 *
 * A transcript is read incrementally. It only grows, so each reader keeps how far it got and each pass reads what was
 * added since; only whole lines are handed over, because the last one may still be being written. Readers of the same
 * file that ask at the same moment share one pass, so two of them catching up on a transcript of several hundred
 * megabytes read it once rather than once each.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Claude Code's own directory: CLAUDE_CONFIG_DIR when set, as Claude Code reads it, and ~/.claude otherwise. */
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
/* One folder per starting directory, and in each one transcript per conversation, named by its session id. */
const projectsDir = () => path.join(claudeDir(), 'projects');

/* Where every plugin keeps its own data, and the name of the companion plugin's. The two are kept apart because a file
   watcher needs a base that already exists, and the plugin's is created when the plugin is installed - which may be
   after this extension has started. */
const DATA_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'data');
const PLAN_DIR = require('./plugin-install').DATA_DIR;
const planDir = () => path.join(DATA_ROOT, PLAN_DIR);

/** A session id as Claude Code writes it. */
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * The project folders, or null when the projects folder itself cannot be read. A folder that is a symbolic link to a
 * directory is one Claude Code reads and writes through, so it counts as one.
 */
function projectFolders(projects = projectsDir()) {
  let entries;
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); } catch (_) { return null; }
  const out = [];
  for (const e of entries) {
    const dir = path.join(projects, e.name);
    if (e.isDirectory()) out.push(dir);
    else if (e.isSymbolicLink()) {
      try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch (_) { /* a link to nothing */ }
    }
  }
  return out;
}

/*
 * Where each conversation's transcript was found, and when a search last found none. A session id is unique across every
 * project on a machine, so a transcript found once is known. One not found - a conversation whose first message is not
 * written yet - is looked for again only after MISS_MS: a search stats a file in every project folder, and the
 * conversation in front of the reader is asked about by several callers within the same moment and every half minute.
 */
const MISS_MS = 10000;
const found = new Map();
const missed = new Map();

/** The transcript of one conversation, or '' when there is none. */
function transcriptOf(session, projects = projectsDir(), now = Date.now()) {
  if (!SESSION.test(String(session || ''))) return '';
  const key = projects + '\0' + session;
  const known = found.get(key);
  if (known && fs.existsSync(known)) return known;
  found.delete(key);
  if (now - (missed.get(key) || -Infinity) < MISS_MS) return '';
  for (const dir of projectFolders(projects) || []) {
    const file = path.join(dir, session + '.jsonl');
    if (fs.existsSync(file)) { missed.delete(key); found.set(key, file); return file; }
  }
  if (missed.size > 500) missed.clear();
  missed.set(key, now);
  return '';
}

/**
 * Every session id that still has a transcript, or null when that could not be established.
 *
 * Null rather than an incomplete set, because the two mean opposite things to a caller deciding what is abandoned: a
 * project folder that cannot be listed would make every conversation in it look gone, and its plans would be deleted. A
 * machine really holding no transcripts is refused the same way, since it holds nothing to lose.
 *
 * Only the one level is read. Deeper down are the transcripts of sub-agents, which are not conversations.
 */
function liveSessions(projects = projectsDir()) {
  const folders = projectFolders(projects);
  if (!folders) return null;
  const live = new Set();
  for (const dir of folders) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return null; }
    for (const n of names) if (n.endsWith('.jsonl')) live.add(n.slice(0, -6));
  }
  return live.size ? live : null;
}

const CHUNK = 8 << 20;
/* The readers waiting for a pass over each file. A pass starts once the requests made at the same moment are in. */
const batches = new Map();

/**
 * Hand `reader` the whole lines `file` holds past `reader.pos`, moving `reader.pos` past the last of them. Resolves to
 * false when the file cannot be read.
 *
 * `reader.take(data, at)` is given a buffer of whole lines that starts at file offset `at`, in file order, and may be
 * called several times; the buffer is reused once it returns. A file shorter than `reader.pos` was replaced rather than
 * appended to, so the reader is read again from the start, after `reader.reset()` if it has one.
 */
function readLines(file, reader) {
  let batch = batches.get(file);
  if (!batch) {
    batch = { readers: [] };
    batches.set(file, batch);
    batch.done = new Promise((resolve) => setImmediate(resolve)).then(() => {
      batches.delete(file);
      return pass(file, batch.readers);
    });
  }
  batch.readers.push(reader);
  return batch.done;
}

async function pass(file, readers) {
  let size;
  try { size = (await fs.promises.stat(file)).size; } catch (_) { return false; }
  for (const r of readers) {
    if (r.pos > size) { r.pos = 0; if (r.reset) r.reset(); }
  }
  const from = Math.min(...readers.map((r) => r.pos));
  if (from >= size) return true;
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch (_) { return false; }
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, size - from));
    let pos = from, carry = Buffer.alloc(0);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      const start = pos - carry.length;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) { carry = Buffer.from(data); continue; }
      const whole = data.subarray(0, end + 1), past = start + whole.length;
      for (const r of readers) {
        if (r.pos >= past) continue;
        const skip = Math.max(0, r.pos - start);
        r.take(whole.subarray(skip), start + skip);
        r.pos = past;
      }
      carry = Buffer.from(data.subarray(end + 1));
    }
  } finally {
    await fh.close();
  }
  return true;
}

/**
 * `run(key, opts)`, one at a time per key, with no request lost.
 *
 * A request made while a pass runs is not handed that pass's result: the pass read the file before the request was made,
 * and with someone else's options. It joins one more pass that starts when the current one ends, and every request made
 * meanwhile shares it, their options folded together by `merge`.
 */
function oneAtATime(run, merge = (a, b) => Object.assign({}, a, b)) {
  const running = new Map();
  const start = (key, opts) => {
    const slot = { next: null };
    running.set(key, slot);
    slot.done = Promise.resolve().then(() => run(key, opts)).finally(() => {
      if (running.get(key) === slot) running.delete(key);
      const next = slot.next;
      if (next) start(key, next.opts).done.then(next.resolve, next.reject);
    });
    return slot;
  };
  return (key, opts = {}) => {
    const slot = running.get(key);
    if (!slot) return start(key, opts).done;
    if (slot.next) { slot.next.opts = merge(slot.next.opts, opts); return slot.next.promise; }
    const next = { opts };
    next.promise = new Promise((resolve, reject) => { next.resolve = resolve; next.reject = reject; });
    slot.next = next;
    return next.promise;
  };
}

/*
 * Written whole beside the file and renamed over it, so a reader in another window or another process sees the old
 * contents or the new ones. The temporary name is this process's own, with a random part, since several windows write
 * these same files; a copy that could not be put in place is removed.
 */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
    throw e;
  }
}

module.exports = {
  claudeDir, projectsDir, planDir, DATA_ROOT, PLAN_DIR, SESSION, projectFolders, transcriptOf, liveSessions,
  readLines, oneAtATime, writeAtomic, MISS_MS, CHUNK,
};

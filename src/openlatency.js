// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * How long a Claude Code panel takes before it starts loading, read out of the official extension's own log.
 *
 * That log already timestamps every line to the millisecond, so nothing here has to be measured - it has to be paired.
 * The waiting a person actually notices sits between two lines that are far apart in the file and mean nothing on their
 * own: a request arrives from the webview, or the host activates, and then the log goes silent until a newly created
 * panel says `init`. The silence is the wait.
 *
 * Three pairings are kept, because a slow open can come from any one of them and the three move independently:
 *
 *   panel      a panel was asked for (or the window restored one) -> that panel's first `init`
 *   cli        the host spawned the CLI -> the first line that CLI printed
 *   host       any two adjacent lines of the host's own, when the space between them is long
 *
 * A `waited` figure is only honest when its start is an event rather than a person: `open_in_editor` arrives because
 * something was clicked, and activation happens because a window opened, so neither carries think-time. A pairing whose
 * start could be "nobody touched it for a while" is dropped instead of recorded, which is why `panel` records need a
 * trigger and are skipped without one.
 *
 * The file is read from a remembered offset. A log grows to megabytes in a day and is re-read on a timer, so parsing it
 * whole every time would put the cost of this in the same place as the problem it measures.
 */
const fs = require('fs');
const path = require('path');

/** `2026-09-29 21:04:21.660 [info] message` - a line that is the host's own, rather than a continuation. */
const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[(\w+)\] ([\s\S]*)$/;
/*
 * A floor for the host's own silence only.
 *
 * Panel and CLI waits have no floor, because every one of them is counted even when it is fast - that count is what says
 * whether a slow open is the exception or the rule, and a version whose opens went from mostly fast to mostly slow has
 * regressed even if its worst figure did not move. The host's gaps are different: they are not openings of anything, so
 * there is no denominator to belong to, and without a floor every pause in its logging would arrive as one.
 */
const HOST_FLOOR_MS = 1500;
/* A gap longer than this is taken to be a window left alone, not a wait, and is dropped rather than recorded. */
const CEILING_MS = 10 * 60 * 1000;
/* Waits at or above this are recorded one by one; below it only the count is kept. Overridden from settings. */
const THRESHOLD_MS = 10000;
/* How many records to keep per window. One open is one record, so this is months of them. */
const KEEP = 2000;
/* Trimming rewrites the file, so it is done in batches rather than on every append. */
const TRIM_AT = Math.floor(KEEP * 1.5);
/* A window's file is removed this long after that window last wrote to it. Its pid is gone by then and will be reused. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/* The editor's log writes the extension host's local time with no zone, so it is read back as local time. Read as UTC
   it is off by the zone's offset, and set against the clock in `sample` a click in a zone behind UTC becomes a request
   hours old. */
function at(m) {
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
}

/** The host's own lines, in order, as `{ ms, level, text }`. Continuation lines of the CLI's output are dropped. */
function lines(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const m = LINE.exec(raw);
    if (m) out.push({ ms: at(m), level: m[8], text: m[9] });
  }
  return out;
}

/** What kind of event a line is, for the pairings above; null for everything else. */
function kindOf(text) {
  if (text.startsWith('Claude code extension is now active')) return 'activate';
  if (text.startsWith('Received message from webview:')) {
    if (text.includes('"type":"init"')) return 'panel-up';
    if (text.includes('"type":"open_in_editor"')) return 'panel-asked';
    return 'webview';
  }
  if (text.startsWith('Spawning Claude with SDK query function')) return 'cli-spawn';
  if (text.startsWith('From claude:')) return 'cli-said';
  return null;
}

/**
 * The waits found in one stretch of log text.
 *
 * `panel` pairs each `init` with the most recent thing that asked for a panel and has no other `init` after it, so two
 * panels opening together are not both credited with the first one's wait.
 */
function readOut(text, pending = {}) {
  const rows = lines(text);
  const out = [];
  /* Carried in and back out, because the log is read in pieces: a wait longer than the gap between two reads has its
     start in one piece and its end in another, and a pairing that only lived inside one call could never join them. That
     silently dropped exactly the waits worth recording - the short ones fit in one piece and the long ones did not. */
  let asked = pending.asked || null;
  let spawned = pending.spawned || null;
  /* The host's last line of the previous piece, so a silence spanning two reads is measured like one inside a read. */
  let prev = pending.last || null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const kind = kindOf(row.text);
    const before = prev;
    prev = { ms: row.ms, text: row.text.slice(0, 200) };
    if (kind === 'activate' || kind === 'panel-asked') {
      /* A new request long after one that is still pending means the first panel never came up and was abandoned, while
         two requests in quick succession are two panels opening together. So the gap must be at least HOST_FLOOR_MS,
         and it is reported as the time waited. A gap past CEILING_MS is not reported: the window was just left alone,
         as can happen with a panel that does come up. */
      if (asked && row.ms - asked.ms >= HOST_FLOOR_MS && row.ms - asked.ms <= CEILING_MS) {
        out.push({
          what: 'abandoned', trigger: asked.trigger,
          at: new Date(asked.ms).toISOString(), waited: row.ms - asked.ms,
        });
      }
      asked = { ms: row.ms, trigger: kind === 'activate' ? 'window' : 'click' };
      continue;
    }
    if (kind === 'panel-up') {
      if (asked) {
        const waited = row.ms - asked.ms;
        if (waited <= CEILING_MS) {
          out.push({ what: 'panel', trigger: asked.trigger, at: new Date(asked.ms).toISOString(), waited });
        }
        asked = null;
      }
      continue;
    }
    if (kind === 'cli-spawn') {
      spawned = { ms: row.ms, resume: !/resume: undefined/.test(row.text) };
      continue;
    }
    if (kind === 'cli-said' && spawned) {
      const waited = row.ms - spawned.ms;
      if (waited <= CEILING_MS) {
        out.push({ what: 'cli', trigger: spawned.resume ? 'resume' : 'new', at: new Date(spawned.ms).toISOString(), waited });
      }
      spawned = null;
      continue;
    }
    /* The host's own silence. Only between two of its own lines, since a gap ending at a webview message is one of the
       pairings above and would otherwise be counted twice. */
    if (before && kind === null && kindOf(before.text) === null) {
      const waited = row.ms - before.ms;
      if (waited >= HOST_FLOOR_MS && waited <= CEILING_MS) {
        out.push({
          what: 'host', trigger: before.text.slice(0, 60),
          at: new Date(before.ms).toISOString(), waited,
        });
      }
    }
  }
  return { waits: out, pending: { asked, spawned, last: prev } };
}

/**
 * The official extension's log for THIS window.
 *
 * Derived from our own log directory rather than by taking the newest under `logs/`: the directories accumulate for
 * every session a machine has ever had and `exthostN` numbers get reused, so picking by name or by time is a guess.
 * Ours is a sibling of theirs inside the one directory that belongs to this extension host.
 */
function logFile(ourLogDir) {
  return path.join(path.dirname(ourLogDir), 'Anthropic.claude-code', 'Claude VSCode.log');
}

/**
 * Split waits into the ones worth a record of their own and a count of the rest.
 *
 * Only openings of something are counted: a host gap under the threshold is dropped rather than tallied, because it is
 * not an attempt at anything and so has no total it could be a fraction of.
 */
function split(waits, thresholdMs = THRESHOLD_MS) {
  const slow = [];
  const fast = {};
  for (const w of waits || []) {
    if (w.waited >= thresholdMs) { slow.push(w); continue; }
    /* Neither of these is an opening that finished, so neither belongs in a count of how many did. A short `abandoned`
       is someone clicking twice in a row rather than giving up on anything. */
    if (w.what === 'host' || w.what === 'abandoned') continue;
    const key = `${w.what}/${w.trigger}`;
    fast[key] = (fast[key] || 0) + 1;
  }
  return { slow, fast };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One line standing for every fast open of a day, so a healthy day costs one line rather than a line per open. */
function tallyRecord(day, version, counts) {
  return { what: 'tally', day, version, counts };
}

function addCounts(into, from) {
  for (const k of Object.keys(from || {})) into[k] = (into[k] || 0) + from[k];
  return into;
}

/*
 * One file per window, named by the extension host's process id.
 *
 * A window is a separate extension host with its own timer, and nothing coordinates them. Sharing one file would mean
 * read-modify-write from several processes at once: the last writer replaces whatever the others added, and a shared
 * temporary name lets two of them interleave bytes into it and each rename the result into place, so the file can end up
 * holding neither version. With one writer per file there is nothing to coordinate - appends go to the end of a file only
 * this window writes, and trimming it is safe for the same reason.
 */
const NAME = /^open-latency-\d+\.jsonl$/;

function recordFile(dir, pid = process.pid) {
  return path.join(dir, `open-latency-${pid}.jsonl`);
}

function readRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a torn line from a write that did not finish */ }
  }
  return out;
}

/** Every window's records together, oldest wait first. Reading is where the per-window files are put back into one set. */
function readAll(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) if (NAME.test(name)) out.push(...readRecords(path.join(dir, name)));
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return out;
}

/** Drop the files of windows long gone, so a machine does not collect one per extension host it has ever run. */
function prune(dir, now = Date.now(), keepFile = '') {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  let gone = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    if (!NAME.test(name) || file === keepFile) continue;
    try {
      if (now - fs.statSync(file).mtimeMs < STALE_MS) continue;
      fs.unlinkSync(file);
      gone++;
    } catch (_) { /* another window got there first, which is the ordinary outcome rather than a fault */ }
  }
  return gone;
}

/*
 * Read the complete lines between byte offsets `from` and `size`. Returns { text, to }, where `to` is the offset just
 * past the last newline.
 *
 * The log may be mid-append, so a trailing partial line is left for the next read. Reads can come back short for the
 * same reason; only the bytes read are decoded, since the rest of the allocUnsafe buffer is uninitialised.
 */
function wholeLines(file, from, size) {
  if (size <= from) return { text: '', to: from };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(size - from);
    const got = fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a, got - 1);
    if (end === -1) return { text: '', to: from };
    return { text: buf.toString('utf8', 0, end + 1), to: from + end + 1 };
  } finally { fs.closeSync(fd); }
}

/* Where the editor moves a log once it reaches its size limit: `Claude VSCode.log` becomes `Claude VSCode.1.log`, and the
   ones before it move up a number. */
function rotatedFile(log) {
  return log.replace(/(\.log)?$/, '.1$1');
}

/**
 * Read whatever is new in the log and append the slow waits to this window's record file. Returns what was added.
 *
 * `state` is kept in memory by the caller: `{ file, ino, size }` identifies the log and the read offset, `pending`
 * holds the open pairings, plus the current day's count of fast opens. It is not shared between windows, since each
 * window has its own log and a reload starts a new one.
 *
 * A log that was moved aside at its size limit is finished first from the saved offset, and then the new one is read
 * from its start. Any other change of file starts from the beginning, with nothing pending.
 *
 * Fast opens are held in that state and written out as one line when the day turns, so an ordinary day leaves a line
 * rather than a line per open. A host that goes away before the day turns loses that day's count for that window, which
 * costs a denominator and no recorded wait.
 */
function sample(opts) {
  const { log, dir, state = {}, version = '', now = Date.now(), pid = process.pid,
    thresholdMs = THRESHOLD_MS } = opts;
  const into = recordFile(dir, pid);
  let stat;
  try { stat = fs.statSync(log); } catch (_) { return { added: [], state, why: 'no log for this window yet' }; }
  const same = state.file === log && Number.isFinite(state.size);
  const moved = same && ((state.ino && state.ino !== stat.ino) || state.size > stat.size);
  const from = same && !moved ? state.size : 0;
  const pendingIn = same ? (state.pending || {}) : {};
  /* Nothing new still has to hand the state back whole. Returning a trimmed copy loses the half-finished pairing and the
     day's count, so the wait in progress right now would end up with no beginning. */
  if (!moved && from === stat.size) {
    return { added: [], state: Object.assign({}, state, { file: log, ino: stat.ino, size: from, pending: pendingIn }), why: '' };
  }
  let text = '', size = from;
  try {
    if (moved) {
      const old = rotatedFile(log);
      let rest = null;
      try { rest = fs.statSync(old); } catch (_) { /* moved somewhere this does not look */ }
      if (rest && (state.ino ? rest.ino === state.ino : rest.size >= state.size)) text = wholeLines(old, state.size, rest.size).text;
    }
    const r = wholeLines(log, from, stat.size);
    text += r.text;
    size = r.to;
  } catch (e) { return { added: [], state, why: 'could not read the log: ' + e.message }; }

  const read = readOut(text, pendingIn);
  const pending = Object.assign({}, read.pending);
  /* A request still waiting once the ceiling has passed never arrived at all. Recorded rather than forgotten, because
     otherwise the worst case - a panel that simply does not open - is the one case that leaves nothing behind. Its
     figure is how long it had been waiting when it was written off, which is a floor on the real answer, not the answer.
     A panel that turns up later has nothing left to pair with, and that is the right outcome: it was already counted. */
  if (pending.asked && now - pending.asked.ms > CEILING_MS) {
    read.waits.push({
      what: 'abandoned', trigger: pending.asked.trigger,
      at: new Date(pending.asked.ms).toISOString(), waited: now - pending.asked.ms, open: true,
    });
    pending.asked = null;
  }
  const { slow, fast } = split(read.waits, thresholdMs);
  const added = slow.map((r) => Object.assign({ seen: new Date(now).toISOString(), version }, r));

  /* The day's count carries over between calls; when the day turns, the finished day goes out as its own line. */
  const today = dayOf(now);
  const counts = addCounts(state.day === today ? Object.assign({}, state.counts) : {}, fast);
  const lines = added.slice();
  if (state.day && state.day !== today && state.counts && Object.keys(state.counts).length) {
    lines.unshift(tallyRecord(state.day, state.version || version, state.counts));
  }

  if (lines.length) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      /* One call with every new record in it. Appending is atomic per write on a local filesystem, so a whole buffer
         lands in one piece; writing them one at a time would be several appends that another writer could sit between. */
      fs.appendFileSync(into, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
      trim(into);
      prune(dir, now, into);
    } catch (e) { return { added: [], state, why: 'could not write the records: ' + e.message }; }
  }
  return {
    added,
    state: { file: log, ino: stat.ino, size, day: today, counts, version, pending },
    why: '',
  };
}

/**
 * Write out the day's running count now rather than waiting for the day to turn.
 *
 * Called when the window is closing, which is the only other moment the count is certain to be complete.
 */
function flush(opts) {
  const { dir, state = {}, pid = process.pid } = opts;
  if (!state.day || !state.counts || !Object.keys(state.counts).length) return 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(recordFile(dir, pid),
      JSON.stringify(tallyRecord(state.day, state.version || '', state.counts)) + '\n');
  } catch (_) { return 0; }
  return Object.values(state.counts).reduce((a, b) => a + b, 0);
}

/**
 * Keep this window's file to the newest KEEP records, in batches.
 *
 * Safe to rewrite because only this window writes this file. The temporary name carries the pid for the same reason the
 * file does: two windows trimming at once must not be handed the same scratch path.
 */
function trim(file) {
  const all = readRecords(file);
  if (all.length <= TRIM_AT) return 0;
  const kept = all.slice(-KEEP);
  const tmp = `${file}.${process.pid}.writing`;
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
  return all.length - kept.length;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

/**
 * A readable summary: one row per kind of wait, worst first, split by version.
 *
 * `fast` comes from the tally lines and is the rest of the denominator - `slow` alone says how bad it got, and the two
 * together say how often it got there. A version where 2 of 40 opens were slow and one where 19 of 31 were can have the
 * same worst figure, and only the second has regressed.
 */
function summarise(records) {
  const groups = new Map();
  const fast = new Map();
  for (const r of records || []) {
    if (!r) continue;
    if (r.what === 'tally') {
      for (const k of Object.keys(r.counts || {})) {
        const key = k.replace('/', '\t') + '\t' + (r.version || '');
        fast.set(key, (fast.get(key) || 0) + r.counts[k]);
      }
      continue;
    }
    if (typeof r.waited !== 'number') continue;
    const key = (r.what || '?') + '\t' + (r.trigger || '') + '\t' + (r.version || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.waited);
  }
  const rows = [];
  for (const [key, all] of groups) {
    const [what, trigger, version] = key.split('\t');
    const sorted = all.slice().sort((a, b) => a - b);
    rows.push({
      what,
      trigger: what === 'host' ? trigger.slice(0, 44) : trigger,
      version,
      n: sorted.length,
      fast: fast.get(key) || 0,
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      worst: sorted[sorted.length - 1],
    });
    fast.delete(key);
  }
  /* A kind with nothing slow left at all still belongs in the report - that is the healthy case, and leaving it out
     would make a version that stopped being slow look like a version nobody used. */
  for (const [key, count] of fast) {
    const [what, trigger, version] = key.split('\t');
    rows.push({ what, trigger, version, n: 0, fast: count, median: 0, p90: 0, worst: 0 });
  }
  rows.sort((a, b) => b.p90 - a.p90 || b.fast - a.fast);
  return rows;
}

const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/** The summary as lines for the output channel. */
function report(records, thresholdMs = THRESHOLD_MS) {
  const rows = summarise(records);
  if (!rows.length) return ['open latency: nothing recorded yet'];
  const out = [
    `open latency: waits of ${secs(thresholdMs)} or more are recorded one by one; faster ones are counted only`,
    '  what    trigger                                    slow   fast   median      p90    worst  version',
  ];
  for (const r of rows) {
    out.push('  ' + [
      r.what.padEnd(6), r.trigger.padEnd(41),
      String(r.n).padStart(4), String(r.fast).padStart(6),
      secs(r.median).padStart(8), secs(r.p90).padStart(8), secs(r.worst).padStart(8), r.version,
    ].join(' '));
  }
  return out;
}

module.exports = {
  lines, kindOf, readOut, split, tallyRecord, addCounts, dayOf, logFile, recordFile, readRecords, readAll,
  prune, trim, sample, flush, summarise, report,
  HOST_FLOOR_MS, CEILING_MS, THRESHOLD_MS, KEEP, TRIM_AT, STALE_MS, NAME,
};

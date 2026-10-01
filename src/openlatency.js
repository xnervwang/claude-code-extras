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

function at(m) {
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
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
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const kind = kindOf(row.text);
    if (kind === 'activate' || kind === 'panel-asked') {
      /* A fresh request while one is still pending, long after it: the first panel never came up and was given up on.
         Quick succession is two panels opening together instead, so the gap has to be worth calling a wait - and that
         same gap is how long someone sat there before closing it, which is the only figure this case can report. */
      if (asked && row.ms - asked.ms >= HOST_FLOOR_MS) {
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
    if (i > 0 && kind === null && kindOf(rows[i - 1].text) === null) {
      const waited = row.ms - rows[i - 1].ms;
      if (waited >= HOST_FLOOR_MS && waited <= CEILING_MS) {
        out.push({
          what: 'host', trigger: rows[i - 1].text.slice(0, 60),
          at: new Date(rows[i - 1].ms).toISOString(), waited,
        });
      }
    }
  }
  return { waits: out, pending: { asked, spawned } };
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

/**
 * Read whatever is new in the log and append the slow waits to this window's record file. Returns what was added.
 *
 * `state` is read and written by the caller, since where it is kept belongs to the extension: `{ file, size }` is the
 * log this offset refers to and how far it had been read, plus the day's running count of fast opens and which day that
 * is. A log that shrank or changed name is read from the start.
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
  const from = (state.file === log && state.size <= stat.size) ? state.size : 0;
  /* Nothing new still has to hand the state back whole. Returning a trimmed copy loses the half-finished pairing and the
     day's count, so the wait in progress right now would end up with no beginning. */
  const carry = (size) => ({
    file: log, size, day: state.day, counts: state.counts, version: state.version || version,
    pending: state.pending,
  });
  if (from === stat.size) return { added: [], state: carry(stat.size), why: '' };
  /* One byte before the offset comes too, and it is what says whether the offset sat on a line boundary. Without it a
     resume that landed exactly after a newline discards the first whole line - which is usually the trigger, so the
     wait that follows pairs with nothing and the file silently records fewer waits than happened. */
  const back = from > 0 ? 1 : 0;
  let text = '';
  try {
    const fd = fs.openSync(log, 'r');
    try {
      const buf = Buffer.allocUnsafe(stat.size - from + back);
      /* Only as far as the read actually got. The log is being appended to while this runs, so a short read is ordinary,
         and the rest of an unsafely allocated buffer is whatever was in that memory - which parses as garbage. */
      const got = fs.readSync(fd, buf, 0, buf.length, from - back);
      text = buf.toString('utf8', 0, got);
    } finally { fs.closeSync(fd); }
  } catch (e) { return { added: [], state, why: 'could not read the log: ' + e.message }; }

  if (back) text = text[0] === '\n' ? text.slice(1) : text.slice(text.indexOf('\n') + 1);

  const read = readOut(text, state.pending || {});
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
    state: { file: log, size: stat.size, day: today, counts, version, pending },
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

/*
 * TEMPORARY, FOR ONE INVESTIGATION. Delete this and its three call sites once the panel's slow first message is
 * understood: the watcher below, the timer in extension.js that drives it, and the stretch of report() that prints what
 * it collected. The `hostbusy` records it leaves behind are then meaningless and the reader is swept with the rest.
 *
 * It is not a feature and nobody asked for the number. It exists because one question could not be answered any other
 * way, and it earns its place only until that question is answered - a diagnostic kept past its investigation becomes
 * something later readers have to take seriously, and a per-second timer is the last thing to leave lying around in an
 * extension whose whole discipline is not costing the editor anything.
 *
 * Whether the extension host was running during a wait, which is the one thing the wait itself does not say.
 *
 * A panel that takes 94 seconds to send its first message has been seen, with the host side silent throughout, and that
 * is as far as a wait can take it: silence means either the host was blocked and could not act, or the host was idle and
 * had nothing to act on. Those point at opposite halves of the machine - ours and the panel's - and nothing recorded so
 * far told them apart.
 *
 * A timer asked for every INTERVAL_MS, timed against the clock, answers it. Delay means the host's one thread was busy
 * elsewhere; arriving on time through a long wait means the host was free and waiting on the panel, which rules this
 * side out. An interval it cannot be blamed for is not interesting, so only overruns past LAG_FLOOR_MS are written, and
 * consecutive ones are folded into a single record - a host stalled for a minute would otherwise write sixty.
 *
 * The timer does nothing but read the clock, and it is not a sweep: the cost of looking must not be the thing that makes
 * the reading worse.
 */
const INTERVAL_MS = 1000;
const LAG_FLOOR_MS = 2000;

function lagWatcher(opts = {}) {
  const { dir, version = '', pid = process.pid, now = () => Date.now(),
    interval = INTERVAL_MS, floor = LAG_FLOOR_MS, write = true } = opts;
  let last = now();
  let run = null;
  const out = [];
  const tick = () => {
    const at = now();
    const late = at - last - interval;
    last = at;
    if (late < floor) {
      // A stretch of delay has ended, so it can be written as one record naming its span.
      if (run) {
        const record = { seen: new Date(run.until).toISOString(), version, what: 'hostbusy',
          at: new Date(run.from).toISOString(), blocked: run.late, ticks: run.ticks };
        out.push(record);
        if (write && dir) {
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(recordFile(dir, pid), JSON.stringify(record) + '\n');
          } catch (_) { /* a reading that cannot be filed is not worth failing a window over */ }
        }
        run = null;
      }
      return null;
    }
    if (!run) run = { from: at - late - interval, until: at, late: 0, ticks: 0 };
    run.until = at;
    run.late += late;
    run.ticks++;
    return run;
  };
  return { tick, records: out, get open() { return run; } };
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
  /* TEMPORARY, part of one investigation - goes with the watcher above.

     Stretches where this extension host was itself busy, listed beside the waits because the point is to read one against
     the other. A wait with no stretch overlapping it was a wait on the panel, with this side free the whole time - which
     is the half of the question a wait alone cannot answer. */
  const busy = records.filter((r) => r && r.what === 'hostbusy' && typeof r.blocked === 'number');
  if (busy.length) {
    out.push('', `  this extension host was itself busy ${busy.length} time(s), newest last:`);
    for (const r of busy.slice(-12)) {
      out.push(`    ${r.at}  busy ${secs(r.blocked)} over ${r.ticks} second(s) of sampling`);
    }
    out.push('    a wait that overlaps none of these was spent waiting on the panel, not on this side');
  } else {
    out.push('', '  this extension host has not been busy for a measurable stretch, so any wait above was spent'
      + ' waiting on the panel rather than on this side');
  }
  return out;
}

module.exports = {
  lines, kindOf, readOut, split, tallyRecord, addCounts, dayOf, logFile, recordFile, readRecords, readAll,
  lagWatcher, INTERVAL_MS, LAG_FLOOR_MS,
  prune, trim, sample, flush, summarise, report,
  HOST_FLOOR_MS, CEILING_MS, THRESHOLD_MS, KEEP, TRIM_AT, STALE_MS, NAME,
};

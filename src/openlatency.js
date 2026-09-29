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
/* Below this a gap is ordinary scheduling rather than something a person waited through. */
const FLOOR_MS = 1500;
/* A gap longer than this is taken to be a window left alone, not a wait, and is dropped rather than recorded. */
const CEILING_MS = 10 * 60 * 1000;
/* How many records to keep. One open is one record, so this is months of them. */
const KEEP = 2000;

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
function readOut(text) {
  const rows = lines(text);
  const out = [];
  let asked = null;         // the pending panel request or activation
  let spawned = null;       // the pending CLI spawn
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const kind = kindOf(row.text);
    if (kind === 'activate' || kind === 'panel-asked') {
      asked = { ms: row.ms, trigger: kind === 'activate' ? 'window' : 'click' };
      continue;
    }
    if (kind === 'panel-up') {
      if (asked) {
        const waited = row.ms - asked.ms;
        if (waited >= FLOOR_MS && waited <= CEILING_MS) {
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
      if (waited >= FLOOR_MS && waited <= CEILING_MS) {
        out.push({ what: 'cli', trigger: spawned.resume ? 'resume' : 'new', at: new Date(spawned.ms).toISOString(), waited });
      }
      spawned = null;
      continue;
    }
    /* The host's own silence. Only between two of its own lines, since a gap ending at a webview message is one of the
       pairings above and would otherwise be counted twice. */
    if (i > 0 && kind === null && kindOf(rows[i - 1].text) === null) {
      const waited = row.ms - rows[i - 1].ms;
      if (waited >= FLOOR_MS && waited <= CEILING_MS) {
        out.push({
          what: 'host', trigger: rows[i - 1].text.slice(0, 60),
          at: new Date(rows[i - 1].ms).toISOString(), waited,
        });
      }
    }
  }
  return out;
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

function readRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a half-written last line, which the next write replaces */ }
  }
  return out;
}

/**
 * Read whatever is new in the log and append it to the record file. Returns what was added.
 *
 * `state` is read and written by the caller, since where it is kept belongs to the extension: `{ file, size }` is the
 * log this offset refers to and how far it had been read. A log that shrank or changed name is read from the start.
 */
function sample(opts) {
  const { log, into, state = {}, version = '', now = Date.now() } = opts;
  let stat;
  try { stat = fs.statSync(log); } catch (_) { return { added: [], state, why: 'no log for this window yet' }; }
  const from = (state.file === log && state.size <= stat.size) ? state.size : 0;
  if (from === stat.size) return { added: [], state: { file: log, size: stat.size }, why: '' };
  /* One byte before the offset comes too, and it is what says whether the offset sat on a line boundary. Without it a
     resume that landed exactly after a newline discards the first whole line - which is usually the trigger, so the
     wait that follows pairs with nothing and the file silently records fewer waits than happened. */
  const back = from > 0 ? 1 : 0;
  let text = '';
  try {
    const fd = fs.openSync(log, 'r');
    try {
      const buf = Buffer.allocUnsafe(stat.size - from + back);
      fs.readSync(fd, buf, 0, buf.length, from - back);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) { return { added: [], state, why: 'could not read the log: ' + e.message }; }

  if (back) text = text[0] === '\n' ? text.slice(1) : text.slice(text.indexOf('\n') + 1);

  const added = readOut(text).map((r) => Object.assign({ seen: new Date(now).toISOString(), version }, r));
  if (added.length) {
    const kept = readRecords(into).concat(added).slice(-KEEP);
    try {
      fs.mkdirSync(path.dirname(into), { recursive: true });
      const tmp = into + '.writing';
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
      fs.renameSync(tmp, into);
    } catch (e) { return { added: [], state, why: 'could not write the records: ' + e.message }; }
  }
  return { added, state: { file: log, size: stat.size }, why: '' };
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

/** A readable summary of the records: one block per kind of wait, worst first, split by version. */
function summarise(records) {
  const groups = new Map();
  for (const r of records || []) {
    if (!r || typeof r.waited !== 'number') continue;
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
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      worst: sorted[sorted.length - 1],
    });
  }
  rows.sort((a, b) => b.p90 - a.p90);
  return rows;
}

const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/** The summary as lines for the output channel. */
function report(records) {
  const rows = summarise(records);
  if (!rows.length) return ['open latency: nothing recorded yet'];
  const out = [`open latency: ${records.length} waits recorded, worst kind first`,
    '  what    trigger                                       n   median      p90    worst  version'];
  for (const r of rows) {
    out.push('  ' + [
      r.what.padEnd(6), r.trigger.padEnd(44),
      String(r.n).padStart(4), secs(r.median).padStart(8),
      secs(r.p90).padStart(8), secs(r.worst).padStart(8), r.version,
    ].join(' '));
  }
  return out;
}

module.exports = { lines, kindOf, readOut, logFile, readRecords, sample, summarise, report, FLOOR_MS, CEILING_MS, KEEP };

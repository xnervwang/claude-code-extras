// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The effort each reply was actually sent with, read from the conversation's own transcripts.
 *
 * The panel knows the effort only as the menu's current value, which is not what a past reply used: a setting can pin
 * it, a model can quietly lower it, and the menu changes the moment it is clicked. The transcript records the effort of
 * each request in the reply's own row, and the stream the panel reads does not carry it at all, so this side reads it
 * and hands it over. The model needs none of this - every reply the panel holds carries the model that served it.
 *
 * What is handed over is where the effort changed rather than the effort of every reply: the uuid that starts each run,
 * and the uuid of the last reply read. A long conversation holds tens of thousands of replies and a few dozen changes,
 * and the page walks its replies in order anyway, so a run start is all it needs. A reply after the last one read is
 * one this side has not seen yet, and the page leaves it blank rather than carrying the previous run forward over it.
 *
 * Each transcript - the conversation's own, and one per sub-agent - is read incrementally (src/claude-files.js), and how
 * far is kept beside the plan, so a restart carries on where it stopped. A row is read without parsing it: in a reply's
 * row the top-level type, uuid and effort come after the message, and nothing nested follows them, so the end of the
 * line answers it. A line of any other shape that mentions a reply is parsed whole, which is what keeps a reply quoted
 * inside some other row from being taken for one.
 */
const fs = require('fs');
const path = require('path');
const { planDir, SESSION, transcriptOf, readLines, oneAtATime, writeAtomic } = require('./claude-files');

const SUFFIX = '.effort';
const STATE_FILE = /^[0-9a-f][0-9a-f-]{7,}\.effort$/i;
const REPLY = '"type":"assistant"';
const TAIL = '"type":"assistant","uuid":"';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z]+$/;
/* The conversation's own transcript, keyed apart from the sub-agents' file names; the empty name sorts first. */
const MAIN = '';

const word = (v) => (typeof v === 'string' && WORD.test(v) ? v : '');

/* What the end of a reply's row says, from just after the `"uuid":` key to the end of the line. */
function fromTail(tail, head, sidechains) {
  if (!sidechains && head.includes('"isSidechain":true')) return null;
  const id = tail.slice(1, 37);
  if (!UUID.test(id)) return null;
  const per = /,"perTurnEffort":"([a-z]+)"/.exec(tail);
  const plain = /,"effort":"([a-z]+)"/.exec(tail);
  return { uuid: id, effort: (per && per[1]) || (plain && plain[1]) || '' };
}

/* One line, as { uuid, effort } for a reply, or null for anything else. `sidechains` says whether a sub-agent's rows
   belong here: they do in a sub-agent's own transcript, and not in the conversation's, where an older client wrote them
   too and taking one as the conversation's last reply would mark it read past where it was. */
function readLine(line, sidechains) {
  const at = line.lastIndexOf(TAIL);
  if (at !== -1) {
    const tail = line.slice(at + TAIL.length - 1);
    if (!/[{[]/.test(tail)) return fromTail(tail, line.slice(0, 160), sidechains);
  }
  if (!line.includes(REPLY)) return null;
  let row;
  try { row = JSON.parse(line); } catch (_) { return null; }
  if (!row || row.type !== 'assistant' || typeof row.uuid !== 'string' || !UUID.test(row.uuid)) return null;
  if (!sidechains && row.isSidechain === true) return null;
  return { uuid: row.uuid, effort: word(row.perTurnEffort) || word(row.effort) };
}

const REPLY_BYTES = Buffer.from(REPLY, 'utf8');
const TAIL_BYTES = Buffer.from(TAIL, 'utf8');

/* The line between `s` and `e` of a buffer, read as readLine reads it but decoding only its end where it can. */
function readRow(data, s, e, sidechains) {
  const at = data.lastIndexOf(TAIL_BYTES, e - 1);
  if (at >= s) {
    const tail = data.toString('utf8', at + TAIL_BYTES.length - 1, e);
    if (!/[{[]/.test(tail)) return fromTail(tail, data.toString('utf8', s, Math.min(e, s + 160)), sidechains);
  }
  return readLine(data.toString('utf8', s, e), sidechains);
}

/* Reads what one transcript has added since `st.pos`, moving its runs and its last reply along. A file shorter than where
   reading stopped was replaced rather than appended to, so it is read again in full. Resolves to whether the runs or
   the last reply moved. */
async function readFile(file, st, sidechains) {
  const before = JSON.stringify([st.runs, st.last]);
  const reader = {
    pos: st.pos,
    reset: () => Object.assign(st, { runs: [], last: '', eff: '' }),
    /* Only the lines that mention a reply are decoded at all, and of those only the end. Almost every byte of a
       transcript is content, and turning all of it into strings was most of what a first pass cost. */
    take: (data) => {
      const end = data.length - 1;
      for (let from = 0, at; (at = data.indexOf(REPLY_BYTES, from)) !== -1 && at < end;) {
        const s = data.lastIndexOf(0x0a, at) + 1;
        const e = data.indexOf(0x0a, at);
        const r = readRow(data, s, e, sidechains);
        from = e + 1;
        if (!r) continue;
        st.last = r.uuid;
        if (r.effort && r.effort !== st.eff) { st.runs.push([r.uuid, r.effort]); st.eff = r.effort; }
      }
    },
  };
  if (!(await readLines(file, reader))) return false;
  st.pos = reader.pos;
  return JSON.stringify([st.runs, st.last]) !== before;
}

function readState(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d.files === 'object' && d.files ? d : { files: {} };
  } catch (_) {
    return { files: {} };
  }
}

function writeState(file, state) {
  writeAtomic(file, JSON.stringify(state) + '\n');
}

const hex = (uuid) => uuid.replace(/-/g, '');

/**
 * The rule the page reads: one section per transcript, the conversation's first and then its sub-agents' by name, each
 * its run starts and then its last reply - `<uuid>=<effort>,...!<uuid>`. Built only from the files, in a fixed order, so
 * every window writes the same bytes for the same conversation. It is scoped to an element of its own rather than the
 * root: a custom property set on the root is inherited by every element, and changing it would restyle the whole page.
 */
function css(state) {
  const names = Object.keys(state.files).sort();
  const sections = [];
  for (const name of names) {
    const f = state.files[name];
    if (!f || !f.last) continue;
    sections.push(f.runs.map(([u, e]) => hex(u) + '=' + e).join(',') + '!' + hex(f.last));
  }
  return '#cce-effort{--cce-effort:"' + sections.join(';') + '"}\n';
}

/* What this host has read per conversation, so a pass does not re-read the state file it wrote itself. */
const known = new Map();

/**
 * Read what one conversation's transcripts have added since last time. Resolves to { changed, css }, `css` empty for a
 * conversation with no transcript. One pass per conversation at a time (src/claude-files.js): a request made while one
 * runs gets the pass after it, which reads what was appended meanwhile and reads the sub-agents if any request asked to.
 *
 * `subagents: false` leaves the sub-agents' transcripts out of this pass, for a pass started by a change to the
 * conversation's own: a conversation can hold hundreds of them, and looking at each costs more than reading what the
 * conversation added.
 */
function scan(session, opts = {}) {
  if (!SESSION.test(String(session || ''))) return Promise.resolve({ changed: false, css: '' });
  return scanQueued(session, opts);
}

async function scanOnce(session, opts) {
  const dir = opts.dir || planDir();
  const transcript = opts.transcript || transcriptOf(session, opts.projects);
  if (!transcript) return { changed: false, css: '' };
  const file = path.join(dir, session + SUFFIX);
  const state = known.get(session) || readState(file);
  known.set(session, state);
  const fileState = (name) => state.files[name] || (state.files[name] = { pos: 0, runs: [], last: '', eff: '' });
  /* The conversation's own transcript is asked for before anything is awaited, so that a scan of the same transcript
     for the agent map, started at the same moment, shares its pass. */
  const main = readFile(transcript, fileState(MAIN), false);
  main.catch(() => { /* reported where it is awaited below */ });
  const sub = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let subs = [];
  if (opts.subagents !== false) {
    try { subs = (await fs.promises.readdir(sub)).filter((n) => n.endsWith('.jsonl')).sort(); } catch (_) { /* none */ }
  }
  let changed = await main;
  for (const n of subs) {
    if (await readFile(path.join(sub, n), fileState(n), true)) changed = true;
  }
  if (changed) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeState(file, state);
    } catch (_) { /* the next pass writes it */ }
  }
  return { changed, css: css(state) };
}
/* A request that reads the sub-agents and one that does not make, together, a pass that reads them. */
const scanQueued = oneAtATime(scanOnce, (a, b) => Object.assign({}, a, b, { subagents: a.subagents !== false || b.subagents !== false }));

module.exports = { scan, css, readLine, SUFFIX, STATE_FILE };

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Prints how many work plan rows on this machine are stale or incomplete, over the plans written in the last N days
 * (14 by default).
 *
 *   node build/plan-health.js [--days N] [--claude <path to the claude binary>] [--json]
 *
 * Run it before and after a change with the same --days.
 *
 *   - `doing` rows in a conversation that is not running a turn right now, and how long they have said `doing`;
 *   - `waiting` rows that do not say who they wait on;
 *   - questions with more than one question mark.
 *
 * Whether a conversation is running a turn comes from `claude agents --json`. Without the binary those counts are
 * left out.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const DAYS = Number(opt('--days', '14'));
const DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'data',
  'agent-work-plan-claude-code-extras');
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

function claudeBinary() {
  const given = opt('--claude', '');
  if (given) return given;
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const root of [path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')]) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-')).sort().reverse(); } catch (_) { continue; }
    for (const d of dirs) {
      const bin = path.join(root, d, 'resources', 'native-binary', name);
      if (fs.existsSync(bin)) return bin;
    }
  }
  return '';
}

/* Session ids with a turn running now, or null when that cannot be told. */
function busySessions() {
  const bin = claudeBinary();
  if (!bin) return null;
  try {
    const list = JSON.parse(cp.execFileSync(bin, ['agents', '--json'], { encoding: 'utf8', timeout: 30000 }));
    return new Set(list.filter((r) => r && r.status === 'busy').map((r) => r.sessionId));
  } catch (_) { return null; }
}

const QUESTION_MARKS = /[?？]/g;
const hours = (iso, now) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (now - t) / 3600e3 : null; };
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

function measure(now = Date.now()) {
  const busy = busySessions();
  const out = { days: DAYS, plans: 0, rows: 0, doing: 0, doingIdle: busy ? 0 : null, doingIdleHours: [],
    waiting: 0, waitingNoWho: 0, userQuestions: 0, multiQuestion: 0 };
  let names = [];
  try { names = fs.readdirSync(DIR).filter((n) => SESSION.test(n)); } catch (_) { /* no plans */ }
  for (const name of names) {
    const file = path.join(DIR, name);
    let plan;
    try {
      if (now - fs.statSync(file).mtimeMs > DAYS * 86400e3) continue;
      plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { continue; }
    out.plans++;
    const session = name.slice(0, -5);
    const walk = (nodes) => {
      for (const n of Array.isArray(nodes) ? nodes : []) {
        if (!n || typeof n !== 'object') continue;
        out.rows++;
        if (n.state === 'doing') {
          out.doing++;
          if (busy && !busy.has(session)) {
            out.doingIdle++;
            const h = hours(n.since, now);
            if (h !== null) out.doingIdleHours.push(h);
          }
        }
        if (n.state === 'waiting') {
          out.waiting++;
          if (!n.waitingOn) out.waitingNoWho++;
        }
        if (n.waitingOn === 'user' && typeof n.question === 'string' && n.question) {
          out.userQuestions++;
          if ((n.question.match(QUESTION_MARKS) || []).length > 1) out.multiQuestion++;
        }
        walk(n.children);
      }
    };
    walk(plan.nodes);
  }
  const h = out.doingIdleHours;
  out.doingIdleMedianHours = h.length ? Math.round(median(h) * 10) / 10 : null;
  out.doingIdleOverDay = h.filter((x) => x > 24).length;
  out.doingIdleOverWeek = h.filter((x) => x > 168).length;
  delete out.doingIdleHours;
  return out;
}

const r = measure();
if (args.includes('--json')) {
  console.log(JSON.stringify(r));
} else {
  console.log(`plans written to in the last ${r.days} days: ${r.plans} (${r.rows} rows)`);
  if (r.doingIdle === null) console.log(`doing rows: ${r.doing} (whether their conversations are running a turn is unknown: no claude binary)`);
  else {
    console.log(`doing rows: ${r.doing}, of them in a conversation not running a turn now: ${r.doingIdle}`);
    console.log(`  of those, doing for more than a day: ${r.doingIdleOverDay}, more than a week: ${r.doingIdleOverWeek}, median ${r.doingIdleMedianHours} hours`);
  }
  console.log(`waiting rows: ${r.waiting}, not saying who they wait on: ${r.waitingNoWho}`);
  console.log(`rows waiting on the user with a question: ${r.userQuestions}, with more than one question mark: ${r.multiQuestion}`);
}

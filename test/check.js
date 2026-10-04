// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Pre-flight check. Run it after every change to the patchers, before installing.
 *
 * It answers the two questions that decide whether this extension still works:
 *
 *   1. Does everything we ship parse?  Including the injected script, which is a string inside webview.js and so is
 *      invisible to `node --check` on the file itself.
 *   2. Does every edit still match exactly once, on a pristine Claude Code bundle?  A patched file cannot answer this,
 *      so the pristine source is the untouched backup when one exists, or the file itself when it carries no marker.
 *
 * Usage:
 *   node test/check.js                       find Claude Code installs and check against each
 *   node test/check.js <bundle> [<bundle>]   check against bundles named explicitly (index.js / extension.js, or a
 *                                            backup of either — useful while an older patch still owns the live files)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');

const webview = require('../src/webview');
const host = require('../src/host');
const ADAPTERS = require('../src/adapters');
const supported = require('../build/supported');
const { pickShape } = require('../src/edits');

let failures = 0;
/* Checks that could not run, as against ones that ran and passed. Two whole sections need a real Claude Code install and
   an installed copy of this extension, so on a machine that has neither - a CI runner - thirty-odd checks quietly do not
   happen. Counted and printed with the total, because a green run that verified less than the last green run is the one
   result nobody would otherwise notice. */
let skipped = 0;
let passed = 0;
const ok = (msg) => { passed++; console.log('  ok    ' + msg); };
const bad = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const note = (msg) => { skipped++; console.log('  note  ' + msg); };

/* ── 1. everything parses ── */
// Discovered rather than listed, so a new fragment is covered the moment it is added.
function sourceFiles() {
  const root = path.join(__dirname, '..');
  const out = ['extension.js', 'uninstall.js'];
  for (const dir of ['src', path.join('src', 'page')]) {
    for (const f of fs.readdirSync(path.join(root, dir)).sort()) {
      if (f.endsWith('.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

console.log('parse');
for (const f of sourceFiles()) {
  const abs = path.join(__dirname, '..', f);
  try { new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: f }); ok(f); }
  catch (e) { bad(`${f}: ${e.message}`); }
}
try {
  new vm.Script(webview.SCRIPT, { filename: 'injected.js' });
  const fragments = fs.readdirSync(path.join(__dirname, '..', 'src', 'page')).filter((f) => f.endsWith('.js')).length;
  ok(`assembled script (${webview.SCRIPT.split('\n').length} lines from ${fragments} fragments)`);
} catch (e) {
  bad('assembled script: ' + e.message);
}

/* ── 1b. every function the injected script calls has to exist ──
   The script is one closure, so calling a name nobody declares is a ReferenceError when that line runs - not a syntax
   error. `new vm.Script` accepts it, and packaging, installing and reloading all report success, so the only evidence
   is the feature quietly not working. One such name survived eleven releases: a commit that reshaped the chimes
   deleted the two accessors for the stored mute preference and left their three call sites behind. The button was
   still inserted, then threw before it could set its own tooltip, and the sweep's catch swallowed that on every pass.
   The whole visible symptom was an icon with no hover text.

   Heuristic by necessity - regex, not a parser - so it errs toward silence: it only looks at `name(` calls that are
   not property accesses, and it treats everything declared anywhere in the closure as in scope. That is weaker than
   real scope analysis and would miss a name declared in one function and called from another. It still catches the
   only failure that has actually happened, which is a name declared nowhere at all. */
const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'case', 'throw', 'yield', 'await', 'instanceof']);
// Everything the page may legitimately reach without declaring it. Adding to this list is the correct fix when a check
// failure names a real browser or language global; declaring the missing function is the fix for anything else.
const PAGE_GLOBALS = new Set(['window', 'document', 'console', 'navigator', 'performance', 'localStorage',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'requestIdleCallback',
  'getComputedStyle', 'fetch', 'atob', 'btoa', 'encodeURIComponent', 'decodeURIComponent', 'isFinite', 'isNaN',
  'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'RegExp',
  'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Image', 'MutationObserver', 'AudioContext',
  'TextDecoder', 'TextEncoder', 'Range', 'Node', 'Element', 'HTMLElement', 'CustomEvent', 'Event', 'URL',
  'structuredClone', 'queueMicrotask', 'Uint8Array', 'Uint16Array', 'Float32Array', 'ArrayBuffer']);

/* Comments and string literals have to go first, or the scan reports the prose and the CSS: `content:attr(...)` and
   `rgba(...)` and `var(--vscode-…)` are stylesheet text, and a sentence like "call __cceStats() any time" is a hint
   printed to a console. Comments are stripped before strings so an apostrophe in English prose cannot open a string
   and swallow the code after it. */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function undeclaredCalls(source) {
  const src = stripCommentsAndStrings(source);
  const declared = new Set();
  const add = (n) => { if (n) declared.add(n); };
  for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/[,(]\s*([A-Za-z_$][\w$]*)\s*=[^=]/g)) add(m[1]);      // second declarator, or a param default
  for (const m of src.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    add(m[1]);
    for (const p of (m[2] || '').split(',')) add(p.trim().replace(/[=.].*$/, '').trim());
  }
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/g)) add(m[1]);     // arrow parameters
  const missing = new Set();
  for (const m of src.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const n = m[2];
    if (!JS_KEYWORDS.has(n) && !PAGE_GLOBALS.has(n) && !declared.has(n)) missing.add(n);
  }
  return [...missing].sort();
}

const undeclared = undeclaredCalls(webview.SCRIPT);
if (!undeclared.length) ok('every function the injected script calls is declared in it');
else bad(`the injected script calls ${undeclared.length} name(s) it never declares, which throw when reached: ${undeclared.join(', ')}`);

/* ── 2. the injected script must keep its early exit ──
   The loop that walks up the React fiber tree runs for every visible row on every refresh. Dropping the
   `!out.message` condition makes each element walk the full depth instead of three or four levels, which measured
   eight to ten times slower. It has been broken this way once, so it is asserted here. */
if (webview.SCRIPT.includes('!out.message; f = f.return')) ok('hot loop keeps its early exit');
else bad('hot loop lost its early exit — the fiber walk will run to full depth on every element');

/* Every mutation observer has to go through the callback that labels a new block before the browser paints it. There are
   two of them watching different roots, and wiring only one leaves half the blocks appearing at full height and then
   collapsing - the symptom this was written to remove, at half the rate, which reads as the fix not having worked rather
   than as a missed line. Nearly happened while writing it. */
{
  const observers = [...webview.SCRIPT.matchAll(/new MutationObserver\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const direct = observers.filter((n) => n !== 'onMutations');
  if (observers.length >= 2 && !direct.length) ok(`all ${observers.length} mutation observers label a new block before it paints`);
  else if (!observers.length) bad('no mutation observer found in the injected script');
  else bad(`mutation observer(s) bypass the labelling callback: ${direct.join(', ')}`);
}

/* ── 3. shape selection itself ──
   An edit may carry several alternative shapes for builds that differ. The rule is that exactly one shape must match
   exactly once: a shape matching twice is as unusable as one matching never, since neither identifies a single site.
   Checked on synthetic input, because the real bundles only exercise whichever shape they happen to carry. */
console.log('\nshape selection');
{
  const shape = (re, note) => ({ re, to: () => 'X', note });
  const cases = [
    ['first shape wins when it fits', 'aaa bbb', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], 0],
    ['falls through to the shape that fits', 'only bbb here', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], 1],
    ['a shape matching twice is skipped', 'bbb aaa aaa', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], 1],
    ['no shape fits', 'nothing', [shape(/aaa/g, 'new'), shape(/bbb/g, 'old')], null],
  ];
  for (const [what, src, shapes, want] of cases) {
    const got = pickShape(src, { name: 'synthetic', shapes });
    if (want === null) {
      if (got.error && got.error.includes('2 known shapes')) ok(what);
      else bad(`${what}: expected a refusal naming both shapes, got ${JSON.stringify(got.error || got.index)}`);
    } else if (got.index === want) ok(what);
    else bad(`${what}: expected shape ${want + 1}, got ${got.error || 'shape ' + (got.index + 1)}`);
  }
}

/* ── 4. the edits, against a pristine bundle ──
   Finding a bundle and getting its unpatched source come from build/supported.js, which needs exactly the same two
   things to decide which builds go into the record of verified versions. They were written out twice here first, and
   two copies of "where does an unpatched bundle come from" is the kind of pair that drifts without anything failing:
   the record would then attest to something the checks never looked at. */
const { pristine, extensionsDirs } = supported;

/* How often each alternative shape was the one that fitted. A shape no checked build reaches any more cannot be
   verified by anything, and would sit there rotting silently, so it is reported at the end. */
const shapeUse = new Map();
const shapeKey = (adapter, edit, i) => [adapter.name, edit.name, i].join('\u0000');

function checkEdits(adapter, src, label) {
  for (const e of adapter.EDITS) {
    const picked = pickShape(src, e);
    if (picked.error) { bad(`${label}: ${picked.error}`); continue; }
    for (let i = 0; i < picked.total; i++) {
      const k = shapeKey(adapter, e, i);
      if (!shapeUse.has(k)) shapeUse.set(k, { adapter, edit: e, index: i, hits: 0 });
    }
    shapeUse.get(shapeKey(adapter, e, picked.index)).hits++;
    const which = picked.total > 1
      ? ` (shape ${picked.index + 1} of ${picked.total}${picked.note ? ': ' + picked.note : ''})`
      : '';
    ok(`${label}: "${e.name}" matches once${which}`);
  }
  const r = adapter.patchSource(src);
  if (r.error) bad(`${label}: patchSource refused: ${r.error}`);
  else if (!r.out.includes(adapter.MARK)) bad(`${label}: patched output carries no marker`);
  else ok(`${label}: patched output parses and is marked`);
}

/* Not a failure: a shape kept for older builds is expected to go unused once those builds are gone from this machine.
   It is worth saying out loud, because from then on nothing here can tell whether it still works. */
function reportUnusedShapes() {
  const idle = [...shapeUse.values()].filter((s) => s.hits === 0);
  if (!idle.length) return;
  console.log('\nshapes no checked build needed');
  for (const s of idle) {
    const note = s.edit.shapes && s.edit.shapes[s.index] && s.edit.shapes[s.index].note;
    console.log(`  note  ${s.adapter.name}: "${s.edit.name}" shape ${s.index + 1}${note ? ' (' + note + ')' : ''}`);
  }
}

console.log('\nedits');
// Bundle paths to check instead of the installed ones. Options are not paths: passing one used to be reported as
// "no patch target is named --without-version-record", which reads as a broken suite rather than a misread flag.
const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (explicit.length) {
  for (const arg of explicit) {
    const base = path.basename(arg).replace(/\.[^.]*\.bak$/, '');
    const adapter = ADAPTERS.find((a) => base === path.basename(a.targetFile('')));
    if (!adapter) { bad(`${arg}: no patch target is named ${base}`); continue; }
    if (!fs.existsSync(arg)) { bad(`${arg}: not found`); continue; }
    const src = fs.readFileSync(arg, 'utf8');
    if (src.includes(adapter.ANY_MARK)) { bad(`${arg}: already carries our marker, so it is not pristine`); continue; }
    checkEdits(adapter, src, `${adapter.name} <- ${arg}`);
  }
} else {
  let seen = 0;
  for (const dir of Array.from(new Set(extensionsDirs()))) {
    for (const install of webview.findInstalls(dir)) {
      seen++;
      for (const adapter of ADAPTERS) {
        const file = adapter.targetFile(install);
        const p = pristine(file, adapter);
        const where = `${adapter.name} (${path.basename(install)})`;
        if (!p) { bad(`${where}: no pristine source available (patched, and no backup)`); continue; }
        if (p.foreign) { console.log(`  skip  ${where}: another patcher owns this file (${p.foreign})`); continue; }
        checkEdits(adapter, p.src, `${where}, from ${p.from}`);
      }
    }
  }
  if (!seen) note('no Claude Code install found; pass a bundle path to check the edits');
}

reportUnusedShapes();

/* ── 3b. what the model-pill rule actually decides ──
   Matching once says the rule found its place, not that the comparison it leaves behind is right. This runs the
   rewritten comparison itself on the cases that matter: the Bedrock pair that differed only by provider prefix and made
   every reply look like a fallback; a reply from a genuinely different model, which must still count as one, since that
   is the pill's whole reason for comparing; and a 200K pick, which must not be swept into looking like 1M. `strip` is
   the panel's own helper - it removes the 1M marker and nothing else. */
/* ── 3c. the table of contents' top and bottom buttons ──
   Run against a stand-in scroller, since what can go wrong is arithmetic rather than layout: landing short of the end,
   or chasing an end that has moved. A reply still streaming makes the conversation longer while the view is on its way
   down, so the bottom is asserted to be re-measured on the next attempt rather than fixed at the click. */
console.log('\nthe top and bottom buttons');
{
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '45-toc.js'), 'utf8');
  const scroller = {
    scrollTop: 1200, scrollHeight: 5000, clientHeight: 500, parentElement: null,
    scrollTo(o) { this.scrollTop = Math.max(0, Math.min(o.top, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect() { return { top: 0 }; }, addEventListener() {}, removeEventListener() {},
  };
  const message = {
    isConnected: true, parentElement: scroller,
    getBoundingClientRect() { return { top: 100, height: 40, width: 200 }; },
  };
  const ticks = [];
  const box = {
    out: {}, message, ASSIST: 'x', USER: 'y', SEND: 'z',
    document: { querySelector: () => null, documentElement: { scrollHeight: 0 } },
    window: { scrollY: 0, innerHeight: 0, addEventListener() {}, removeEventListener() {} },
    getComputedStyle: (el) => ({ overflowY: el === scroller ? 'auto' : 'visible' }),
    setInterval: (f) => { ticks.push(f); return ticks.length; },
    clearInterval: () => {},
  };
  new vm.Script(`(function(){${fragment}\n;PROMPT_EL.push(message); out.jumpEdge = jumpEdge;})()`, { filename: '45-toc.js' })
    .runInNewContext(box);
  box.out.jumpEdge(true);
  if (scroller.scrollTop === 4500) ok('to the bottom lands at the very end');
  else bad(`to the bottom left the view at ${scroller.scrollTop}, expected 4500`);
  scroller.scrollHeight = 6000;           // a reply grows while the view is held at the end
  ticks[ticks.length - 1]();
  if (scroller.scrollTop === 5500) ok('and follows the end when the conversation grows meanwhile');
  else bad(`the hold did not follow a longer conversation: ${scroller.scrollTop}, expected 5500`);
  box.out.jumpEdge(false);
  if (scroller.scrollTop === 0) ok('to the top lands at the very start');
  else bad(`to the top left the view at ${scroller.scrollTop}`);
}

console.log('\nthe model pill comparison');
{
  const rule = webview.EDITS.find((e) => e.name === 'model pill ignores provider prefix');
  const original = 'h(J)!==h($.resolvedModel??"")';
  const rewritten = original.replace(rule.re, rule.to);
  rule.re.lastIndex = 0;
  const differs = (expr) => new Function('h', 'J', '$', 'return ' + expr);
  const strip = (s) => s.replace(/\[1m\]$/i, '');
  const before = differs(original), after = differs(rewritten);
  const cases = [
    ['a 1M pick on Bedrock, answered by that same model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]', false],
    ['a 200K pick on Bedrock, answered by that same model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5', false],
    ['a regional prefix on the reply instead of the pick', 'us.anthropic.claude-opus-5-5', 'claude-opus-5-5[1m]', false],
    ['a reply from a different model than the one picked', 'claude-opus-5', 'global.anthropic.claude-opus-5-5[1m]', true],
  ];
  if (before(strip, cases[0][1], { resolvedModel: cases[0][2] }) === true) {
    ok('the unpatched comparison does call the Bedrock pair different, which is the bug being fixed');
  } else bad('the unpatched comparison no longer shows the bug, so this rule may be fixing nothing');
  for (const [what, served, pick, want] of cases) {
    const got = after(strip, served, { resolvedModel: pick });
    if (got === want) ok(`${what}: ${want ? 'still counts as a different model' : 'counts as the same model'}`);
    else bad(`${what}: the rewritten comparison said ${got ? 'different' : 'same'}`);
  }

  /* Our own per-reply line has the same fault - it shows the name the reply carries, which on Bedrock never says 1M -
     and puts the marker back from the pick. Same cases, plus the one that only it has: no pick known at all. */
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '75-turn-stats.js'), 'utf8');
  const box = { out: {} };
  new vm.Script(`(function(){${fragment}\n;out.withOneMillion = withOneMillion;})()`, { filename: '75-turn-stats.js' })
    .runInNewContext(box);
  const label = (served, pick) => box.out.withOneMillion(served,
    pick === undefined ? {} : { currentModelInfo: { value: { resolvedModel: pick } } });
  const shown = [
    ['a 1M pick answered by that model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]', 'claude-opus-5-5[1m]'],
    ['a 200K pick answered by that model', 'claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['a 1M pick answered by another model', 'claude-opus-5', 'global.anthropic.claude-opus-5-5[1m]', 'claude-opus-5'],
    ['no pick known yet', 'claude-opus-5-5', undefined, 'claude-opus-5-5'],
  ];
  for (const [what, served, pick, want] of shown) {
    const got = label(served, pick);
    if (got === want) ok(`our per-reply line, ${what}: shows ${want}`);
    else bad(`our per-reply line, ${what}: showed ${got}, expected ${want}`);
  }
}

/* ── 4a. the record of verified Claude Code builds ──
   One equality: the builds the record claims are exactly the builds this machine just verified. Both directions matter
   and for different reasons. A build claimed but not verifiable here means the commit asserts something nothing
   established - which happened, silently, while the record carried builds forward. A build verified here but missing
   from the record means an upgrade goes unrecorded for ever, because a record that is merely conservative never fails
   anything and so nothing ever asks for it to be written again.

   It can only be checked where the bundles are, so a runner with no Claude Code gets a skip rather than a pass, and
   enforcement is local. The place it reaches whoever is working here is this suite, which is the first step of finishing
   any change rather than a separate thing to remember.

   Skipped only by `--without-version-record`, which the one command that writes the record passes when it runs this
   suite first. That is not a way around the gate: this section fails in exactly the state that command exists to
   correct, so leaving it in would block the fix with the defect it fixes. */
/* ── a reopened conversation's window, and what its history is shown ──
   Reopened, the panel has the token count but no window: that arrives only on the message that closes a turn, which the
   transcript never records. These pin down when the page fills the window in, and that the history it replays does not
   pick up the current figures as if they were its own. */
console.log('\na reopened conversation');
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'page', f), 'utf8');
  const box = { out: {}, sessionRef: null, isOn: () => true, isOff: () => false };
  new vm.Script(`(function(){${read('70-meter.js')}\n${read('75-turn-stats.js')}\n;` +
    'out.fillWindow = fillWindow; out.statAt = statAt;})()', { filename: 'reopened' }).runInNewContext(box);
  const session = (usage, pick) => ({
    usageData: { value: Object.assign({ totalTokens: 0, totalCost: 0, contextWindow: 0, maxOutputTokens: 0 }, usage) },
    currentModelInfo: { value: pick === undefined ? undefined : { resolvedModel: pick } },
    lastServedModel: { value: 'claude-opus-5-5' },
  });
  const fill = (usage, pick) => { box.sessionRef = session(usage, pick); box.out.fillWindow(); return box.sessionRef.usageData.value; };

  const cases = [
    ['a 1M pick with 957,707 tokens', { totalTokens: 957707 }, 'global.anthropic.claude-opus-5-5[1m]', 1000000],
    ['a standard pick with 150,000 tokens', { totalTokens: 150000 }, 'global.anthropic.claude-opus-5-5', 200000],
    ['a standard-looking pick holding 300,000 tokens', { totalTokens: 300000 }, 'claude-opus-5-5', 1000000],
    ['no pick known yet, 300,000 tokens', { totalTokens: 300000 }, undefined, 1000000],
    ['no pick known yet, 150,000 tokens', { totalTokens: 150000 }, undefined, 0],
    ['a token count of 0', { totalTokens: 0 }, 'global.anthropic.claude-opus-5-5[1m]', 0],
  ];
  for (const [what, usage, pick, want] of cases) {
    const got = fill(usage, pick).contextWindow;
    if (got === want) ok(want ? `${what}: the window is filled in as ${want}` : `${what}: nothing is filled in`);
    else bad(`${what}: the window came out ${got}, not ${want}`);
  }

  // The meter divides by the window less min(reserve, cap): a filled reserve must sit at or above any plausible cap,
  // and a real one must be left alone.
  const r0 = fill({ totalTokens: 957707 }, 'x[1m]').maxOutputTokens;
  const r1 = fill({ totalTokens: 957707, maxOutputTokens: 32000 }, 'x[1m]').maxOutputTokens;
  if (r0 >= 1e6 && r1 === 32000) ok('a missing reserve is filled above any cap, and a real one is kept');
  else bad(`the reserve came out ${r0} when missing and ${r1} when it was 32000`);

  box.sessionRef = session({ totalTokens: 500000, contextWindow: 1000000 }, 'x[1m]');
  const had = box.sessionRef.usageData.value;
  box.out.fillWindow();
  if (box.sessionRef.usageData.value === had) ok('a window the panel already has is left alone, object and all');
  else bad('fillWindow replaced a window the panel already had');

  box.sessionRef = session({ totalTokens: 500000 }, 'x[1m]');
  box.isOn = () => false;
  box.out.fillWindow();
  const offWin = box.sessionRef.usageData.value.contextWindow;
  box.isOn = () => true;
  if (offWin === 0) ok('with the extension switched off the panel is not touched');
  else bad('fillWindow wrote into the panel with the extension switched off');

  // The history: the newest reply shows the current share, an older one first seen afterwards shows only the model.
  box.sessionRef = session({ totalTokens: 957707, totalCost: 3.2 }, 'global.anthropic.claude-opus-5-5[1m]');
  box.out.fillWindow();
  const older = { id: 'older' }, newest = { id: 'newest' };
  const nowLine = box.out.statAt(newest, true), oldLine = box.out.statAt(older, false);
  if (/ctx 96%/.test(nowLine) && /cost \$3\.20/.test(nowLine)) ok(`the newest reply shows the current figures (${nowLine})`);
  else bad(`the newest reply showed "${nowLine}"`);
  if (!/ctx|cost/.test(oldLine) && /opus-5-5/.test(oldLine)) ok(`a reply from before the page loaded shows the model only (${oldLine})`);
  else bad(`a reply from before the page loaded showed "${oldLine}", taking figures that are not its own`);

  // A reply that was the newest once keeps what it showed then, after a later one takes over.
  const first = { id: 'first' };
  box.out.statAt(first, true);
  box.sessionRef.usageData.value = Object.assign({}, box.sessionRef.usageData.value, { totalTokens: 980000 });
  const kept = box.out.statAt(first, false);
  if (/ctx 96%/.test(kept)) ok('a reply that was once the newest keeps its own figures afterwards');
  else bad(`a reply that was once the newest later showed "${kept}"`);
}

console.log('\nverified builds');
if (process.argv.includes('--without-version-record')) {
  note('asked to skip the record check, which is what writing the record does while it runs this suite');
} else {
  const { verified, problems } = supported.verifyHere();
  const claimed = Object.keys(supported.read().claudeCode).sort(supported.cmpVersion);
  const names = Object.keys(verified).sort(supported.cmpVersion);
  for (const [version, list] of Object.entries(problems)) {
    bad(`Claude Code ${version} is installed here and the rules do not fit it: ${list.join('; ')}`);
  }
  const over = claimed.filter((v) => !verified[v]);
  const under = names.filter((v) => !claimed.includes(v));
  const fix = ' - run: node build/update-versions.js -w';
  if (!names.length && !Object.keys(problems).length) {
    note('no Claude Code install found, so what the record claims cannot be checked here');
  } else if (over.length) {
    bad(`the record claims ${over.join(', ')}, which this machine cannot verify${fix}`);
  } else if (under.length) {
    bad(`${under.join(', ')} verified here but not claimed by the record${fix}`);
  } else if (supported.format(supported.record(verified)) !== fs.readFileSync(supported.SUPPORTED_FILE, 'utf8')) {
    // Same builds, different contents: a rule's shape changed under one of them, which is the detail worth keeping.
    bad(`the record names the right builds but not what they needed${fix}`);
  } else {
    ok(`the record claims exactly what this machine verifies (${names.join(', ')})`);
  }

  /* The README's compatibility sentence against the record. Nothing guarded it before, and it drifted: it named two
     builds while the record named three, on a line people read to decide whether to install. */
  /* The two counts the README quotes, against the manifest. Same reasoning as the sentence below: a number in a
     published document that nothing derives it from goes stale at the first change that moves it. */
  {
    const m = /^.*?(\d+) settings, (\d+) commands\.$/m.exec(fs.readFileSync(supported.README_FILE, 'utf8'));
    const c = require('../package.json').contributes;
    const want = [Object.keys(c.configuration.properties).length, c.commands.length];
    if (!m) bad('README.md does not say "N settings, N commands", so those numbers cannot be kept in step');
    else if (Number(m[1]) !== want[0] || Number(m[2]) !== want[1]) {
      bad(`the manifest has ${want[0]} settings and ${want[1]} commands; README.md says ${m[1]} and ${m[2]}`);
    } else ok(`README.md counts the settings and commands the manifest has (${want[0]}, ${want[1]})`);
  }

  const sentence = supported.readmeClaims();
  if (!sentence) bad('README.md has no "Verified against Claude Code ...; compatibility with other builds unknown." line to keep in step');
  else if (sentence.join(', ') !== claimed.join(', ')) {
    bad(`the record names ${claimed.join(', ')} and README.md names ${sentence.join(', ')}${fix}`);
  } else ok(`README.md names the builds the record does (${supported.listed(claimed)})`);
}

/* ── 4b. the scheduled-prompt section, host to page ──
   The host encodes the tasks into the stylesheet and the page decodes them and builds an element tree, which the panel
   then renders. A mistake in that tree is NOT caught by the try around it - the panel renders it after our code has
   returned - so the whole chain is exercised here against a stand-in element factory. */
console.log('\nscheduled prompts');
{
  const task = {
    id: 'abc12345', cron: '*/7 * * * *', recurring: true,
    createdAt: Date.now() - 86400000, lastFiredAt: Date.now() - 200000,
    session: 'sess-1', project: '/tmp/p', prompt: 'line one\nline "two" with quotes\n中文也要过去',
  };
  const css = webview.liveCss({ enabled: true, userColor: '', tasks: [task] });
  const packed = (css.match(/--cce-schedule:"([^"]+)"/) || [])[1];
  if (!packed) bad('the host did not put the tasks into the stylesheet');
  else if (/[^A-Za-z0-9+/=]/.test(packed)) bad('the encoded value is not safe inside a CSS string');
  else ok('host encodes the tasks into a stylesheet-safe value');

  const calls = [];
  const h = (type, props) => { calls.push({ type, props }); return { type, props }; };
  const sandbox = {
    window: {},
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: () => `"${packed}"` }),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    // Present in any browser this runs in; a fresh vm context does not have Node's globals.
    TextDecoder,
    sigValue: (name) => (name === 'sessionId' ? 'sess-1' : undefined),
    // The assembled script always has it; the fragment reads one switch of its own.
    isOff: () => false,
    console,
  };
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8');
  try {
    new vm.Script(`(function(){${fragment}})()`, { filename: '82-scheduled-tasks.js' }).runInNewContext(sandbox);
  } catch (e) {
    bad('the fragment threw while defining itself: ' + e.message);
  }

  const api = sandbox.window;
  if (typeof api.__cceSchedule !== 'function') bad('__cceSchedule was not defined');
  else {
    const tree = api.__cceSchedule(h);
    if (!tree) bad('the section was empty for a task belonging to this session');
    else {
      const tags = calls.map((c) => c.type);
      for (const want of ['div', 'details', 'summary', 'pre', 'span']) {
        if (!tags.includes(want)) bad(`the tree has no <${want}>`);
      }
      const flat = JSON.stringify(calls);
      if (!flat.includes('every 7 min')) bad('the interval was not rendered in plain English');
      if (!flat.includes('中文也要过去')) bad('a non-ASCII prompt did not survive the round trip');
      const badChildren = calls.filter((c) => c.props && 'children' in c.props && !Array.isArray(c.props.children));
      if (badChildren.length) bad(`${badChildren.length} element(s) pass children as a bare value, not an array`);
      if (!failures) ok(`section builds ${calls.length} elements, prompt round-trips intact`);
    }
    // A task belonging to another session must not show up in this one.
    sandbox.sigValue = (name) => (name === 'sessionId' ? 'someone-else' : undefined);
    if (api.__cceSchedule(h) !== null) bad("another session's task leaked into this panel");
    else ok("another session's task is not shown here");

  }

  /* How each schedule reads, taken off the rendered row rather than from the function, which lives inside the closure.
     The pairs that must NOT be read as an interval carry the whole point: an expression this cannot read is shown
     verbatim, because a reader has no way to tell a wrong reading from a right one. `0,30 9 * * *` fires twice a day
     rather than every thirty minutes, and `5,25,40` is evenly spaced inside an hour but not across the wrap into the
     next one. */
  {
    const READINGS = [
      ['7,27,47 * * * *', 'every 20 min'],       // a repeating gap moved off the hour, which */20 cannot express
      ['0,30 * * * *', 'every 30 min'],
      ['0,15,30,45 * * * *', 'every 15 min'],
      ['*/4 * * * *', 'every 4 min'],
      ['7 * * * *', 'hourly at :07'],
      ['30 9 * * *', 'daily at 9:30'],
      ['0,15,45 * * * *', 'hourly at :00, :15, :45'],   // faithful, since the gaps differ
      ['5,25,40 * * * *', 'hourly at :05, :25, :40'],   // even inside the hour, uneven across it
      ['0,30 9 * * *', '0,30 9 * * *'],                 // an hour is pinned, so it is not an interval at all
      ['7,7 * * * *', '7,7 * * * *'],
      ['7,99 * * * *', '7,99 * * * *'],
      ['7-9 * * * *', '7-9 * * * *'],
      ['0 9 * * 1', '0 9 * * 1'],
      ['', 'unknown interval'],
    ];
    const tasks = READINGS.map(([cron], i) => ({
      id: 'r' + i, cron, recurring: true, session: 'sess-1', project: '/tmp/p', prompt: 'p' + i,
    }));
    const packed = (webview.liveCss({ enabled: true, userColor: '', tasks }).match(/--cce-schedule:"([^"]+)"/) || [])[1];
    const calls = [];
    const h = (type, props) => { calls.push({ type, props }); return { type, props }; };
    const sandbox = {
      window: {},
      document: { documentElement: {} },
      getComputedStyle: () => ({ getPropertyValue: () => `"${packed}"` }),
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      TextDecoder,
      sigValue: (name) => (name === 'sessionId' ? 'sess-1' : undefined),
      // The assembled script always has it; the fragment reads one switch of its own.
      isOff: () => false,
      console,
    };
    const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8');
    new vm.Script(`(function(){${fragment}})()`, { filename: '82-scheduled-tasks.js' }).runInNewContext(sandbox);
    sandbox.window.__cceSchedule(h);
    // One span per row carries the reading and nothing else; the two beside it are styled.
    const read = calls.filter((c) => c.type === 'span' && !(c.props && c.props.style)).map((c) => c.props.children[0]);
    const wrong = [];
    READINGS.forEach(([expr, want], i) => {
      if (read[i] !== want) wrong.push(`${JSON.stringify(expr)} read as ${JSON.stringify(read[i])}, expected ${JSON.stringify(want)}`);
    });
    if (read.length !== READINGS.length) bad(`${READINGS.length} schedules went in, ${read.length} readings came out`);
    else if (wrong.length) bad(`${wrong.length} schedule(s) read wrongly: ${wrong.join('; ')}`);
    else ok(`all ${READINGS.length} schedule shapes read as intended`);
  }

  if (typeof api.__cceAgentsLabel !== 'function') bad('__cceAgentsLabel was not defined');
  else {
    const passthrough = api.__cceAgentsLabel('3 agents', 3);
    if (typeof passthrough === 'string') ok('the button label stays a string');
    else bad('the button label came back as ' + typeof passthrough);
  }
}

/* ── 5. the installed copy must match this working tree ──
   The extension host loads the installed copy, not this tree. A source file added here but missing there makes the
   extension fail to activate on the next reload - it cannot require what was never packaged - and the only symptom is
   that every addition silently disappears. Skipped where nothing is installed, as in CI. */
/* ── the detached sessions a conversation started ──
   Found in the launching conversation's transcript, kept in a small file beside its plan, shown in the agent map. The
   false positives below are real ones: a document describing the output format matched the words, and so did a
   conversation printing an id it had just looked up. The scanning half is asynchronous, so it runs in a child process
   that waits for it and prints what it saw - this suite is synchronous to the end. */
console.log('\nbackground sessions');
{
  const bg = require('../src/background');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-bg-'));
  const jobs = path.join(root, 'jobs'), plans = path.join(root, 'plans'), proj = path.join(root, 'projects', '-p');
  fs.mkdirSync(plans, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const transcript = path.join(proj, SID + '.jsonl');
  const job = (id, fields) => {
    fs.mkdirSync(path.join(jobs, id), { recursive: true });
    fs.writeFileSync(path.join(jobs, id, 'state.json'), JSON.stringify(Object.assign({
      state: 'working', name: 'task ' + id, detail: 'reading files', tokens: 12000,
      createdAt: '2026-10-02T10:00:00.000Z', output: null,
      intent: '<!-- WRITING-CONTRACT\nscope: what this is for\n-->\n\n# Do the thing\nthen stop',
    }, fields || {})));
  };
  let callNo = 0;
  // A call and the result that answers it: two rows, as a transcript records them.
  const ran = (command, text) => {
    const id = 'toolu_' + (++callNo);
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id, name: 'Bash', input: { command } }] } }) + '\n'
      + JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: id, content: text }] } }) + '\n';
  };
  const prose = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text }] } }) + '\n';
  const launched = (id) => `backgrounded · ${id}\n  claude agents             list sessions\n  claude attach ${id}    open in this terminal\n`;
  job('1a2b3c4d');
  job('5e6f7a8b', { state: 'blocked', needs: 'decide which of the two copies to keep' });
  job('0badc0de');
  job('cafef00d');   // a real session, only printed back by another command
  job('deadbea7');
  job('0ddba115');
  job('77777777', { state: 'done', lastTerminalAt: '2026-10-02T11:00:00.000Z', output: { result: 'all 11 ids kept' } });
  fs.writeFileSync(transcript,
    prose('the output looks like backgrounded · 0badc0de, for example') +           // a mention, not a launch
    ran('claude --bg "task one"', launched('1a2b3c4d') + 'note: backgrounded · cafef00d is older\n') + // and one in passing
    ran('cat notes.md', 'the format is backgrounded · [0-9a-f]{8} followed by hints') + // a document describing it
    ran('claude --bg "task two"', 'backgrounded · \x1b[36m5e6f7a8b\x1b[39m\n') +        // the id coloured
    ran('grep -h backgrounded old.jsonl', launched('cafef00d')) +                     // an earlier launch printed back
    ran('claude --bg "task three"', 'Starting background service…\nbackgrounded · deadbea7') + // hints cut off
    ran('claude --bg "task four"', launched('99999999')) +                           // no record of that one
    ran('claude --bg "task six" | sed \'s/^/  /\'', '  ' + launched('0ddba115').split('\n').join('\n  ')));  // output indented

  const scanAll = (steps) => {
    const script = `
      const bg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))});
      const fs = require('fs');
      const opts = ${JSON.stringify({ dir: plans, jobs, transcript })};
      (async () => {
        const out = [];
        for (const step of ${JSON.stringify(steps)}) {
          if (step.append) fs.appendFileSync(opts.transcript, step.append);
          const r = await bg.scan(${JSON.stringify(SID)}, opts);
          let link = null;
          try { link = JSON.parse(fs.readFileSync(opts.dir + '/' + ${JSON.stringify(SID)} + '.background', 'utf8')); } catch (_) {}
          out.push({ r, link });
        }
        process.stdout.write(JSON.stringify(out));
      })().catch((e) => { process.stdout.write(JSON.stringify({ error: e.message })); });`;
    return JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  };

  const half = ran('claude --bg "task five"', launched('77777777'));
  const filler = prose('still working on it');
  const steps = scanAll([
    {},
    { append: filler + half.slice(0, 40) },   // a whole line, then one still being written
    { append: half.slice(40) },                // and then finished
  ]);
  if (steps.error) bad('the scan threw: ' + steps.error);
  else {
    const [first, partial, whole] = steps;
    const ids = (first.link && first.link.ids) || [];
    if (ids.join() === '1a2b3c4d,5e6f7a8b,deadbea7,0ddba115') ok('four launches are found: coloured, with the hints cut off, and indented');
    else bad(`the first scan recorded ${JSON.stringify(ids)}`);
    if (!ids.includes('0badc0de') && !ids.includes('99999999') && !ids.includes('cafef00d')) {
      ok('a mention in prose or in passing, the format written out, a launch printed back by grep, and a session with no record are all left out');
    } else bad(`something that was not a launch was recorded: ${JSON.stringify(ids)}`);
    // In bytes: the middle dot in the CLI's words is two of them, so a string's length is not the file's.
    const size0 = fs.statSync(transcript).size - Buffer.byteLength(filler) - Buffer.byteLength(half);
    const size1 = size0 + Buffer.byteLength(filler);
    if (first.link && first.link.scannedTo === size0) ok('the file records how far the transcript was read');
    else bad(`the recorded position was ${first.link && first.link.scannedTo}, the transcript was ${size0} bytes`);
    if (partial.r.added === 0 && partial.r.scannedTo === size1) ok('a line still being written is not consumed');
    else bad(`a half-written line moved the position to ${partial.r.scannedTo} with ${partial.r.added} added`);
    if (whole.r.added === 1 && whole.link.ids.includes('77777777') && whole.link.scannedTo === size1 + Buffer.byteLength(half)) {
      ok('once the line is whole it is read, from where the last pass stopped');
    } else bad(`after the line was finished: ${JSON.stringify(whole)}`);
  }

  // No file for a conversation that started nothing - one per conversation looked at would be clutter.
  {
    const SID2 = 'bbbbbbbb-1111-2222-3333-444444444444';
    const t2 = path.join(proj, SID2 + '.jsonl');
    fs.writeFileSync(t2, prose('nothing launched here') + ran('ls -la', 'total 0'));
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'background.js'))})
      .scan(${JSON.stringify(SID2)}, ${JSON.stringify({ dir: plans, jobs, transcript: t2 })})
      .then((r) => process.stdout.write(JSON.stringify(r)));`;
    cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    if (!fs.existsSync(path.join(plans, SID2 + '.background'))) ok('a conversation that started nothing gets no file');
    else bad('a file was written for a conversation that started nothing');
  }

  // What the stylesheet carries.
  const list = bg.collect({ dir: plans, jobs });
  const byId = Object.fromEntries(list.map((e) => [e.id, e]));
  const e1 = byId['1a2b3c4d'], e2 = byId['5e6f7a8b'], e3 = byId['77777777'];
  if (list.length === 5 && e1 && e1.session === SID && e1.detail === 'reading files' && e1.tokens === 12000) {
    ok('each recorded session is read from its own state, under the conversation that started it');
  } else bad(`collect gave ${JSON.stringify(list)}`);
  if (e1 && e1.task.startsWith('# Do the thing')) ok('the task is shown without the comment block it opens with');
  else bad(`the task came out as ${JSON.stringify(e1 && e1.task)}`);
  if (e2 && e2.needs === 'decide which of the two copies to keep' && e3 && e3.result === 'all 11 ids kept' && e3.endedAt) {
    ok('what a waiting session needs, and what a finished one concluded, both come through');
  } else bad(`the blocked and done entries were ${JSON.stringify([e2, e3])}`);
  if (JSON.stringify(bg.collect({ dir: plans, jobs })) === JSON.stringify(list)) {
    ok('two windows reading the same files produce the same list');
  } else bad('collect gave a different answer the second time');

  fs.writeFileSync(path.join(jobs, '1a2b3c4d', 'state.json'), '{"state":"work');   // caught mid-write
  const again = bg.collect({ dir: plans, jobs }).find((e) => e.id === '1a2b3c4d');
  if (again && again.detail === 'reading files') ok('a state file caught half-written keeps the last reading');
  else bad(`a half-written state file gave ${JSON.stringify(again)}`);
  fs.rmSync(path.join(jobs, '77777777'), { recursive: true });
  if (!bg.collect({ dir: plans, jobs }).some((e) => e.id === '77777777')) ok('a session whose record is gone drops out');
  else bad('a session with no record left was still listed');

  const css = webview.liveCss({ enabled: true, background: list });
  const off = webview.liveCss({ enabled: true, background: list, off: ['backgroundSessions'] });
  if (/--cce-background:"[A-Za-z0-9+/=]+"/.test(css) && !off.includes('--cce-background')) {
    ok('the list rides in the stylesheet, and the switch keeps it out');
  } else bad('the background property was missing, or present with the switch off');

  // The page: the section, the button's label, and the switch.
  const packed = (css.match(/--cce-background:"([^"]+)"/) || [])[1] || '';
  const calls = [];
  const h = (type, props) => { calls.push({ type, props }); return { type, props }; };
  const off2 = { on: false };
  const sandbox = {
    window: {}, document: { documentElement: {} }, navigator: {},
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--cce-background' ? `"${packed}"` : '') }),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder, console,
    sigValue: (name) => (name === 'sessionId' ? SID : undefined),
    isOff: (k) => off2.on && k === 'backgroundSessions',
  };
  new vm.Script(`(function(){${fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '82-scheduled-tasks.js'), 'utf8')}})()`,
    { filename: '82-scheduled-tasks.js' }).runInNewContext(sandbox);
  const api = sandbox.window;
  const tree = api.__cceSchedule(h);
  const flat = JSON.stringify(calls);
  if (tree && flat.includes('5 background sessions') && flat.includes('Waiting for you: decide which of the two copies')) {
    ok('the agent map lists this conversation\'s sessions, a waiting one saying what it waits for');
  } else bad('the section did not render the sessions as expected');
  if (flat.includes('claude attach 1a2b3c4d') && flat.includes('claude logs 5e6f7a8b')) {
    ok('each session offers the commands to reach it, and nothing that opens it in this panel');
  } else bad('the attach and logs commands were missing');
  const bare = calls.filter((c) => c.props && 'children' in c.props && !Array.isArray(c.props.children));
  if (!bare.length) ok('every element passes its children as an array');
  else bad(`${bare.length} element(s) pass children as a bare value`);
  const label = api.__cceAgentsLabel('3 agents', 3);
  if (label === '3 agents · 4 bg (1 waiting)') ok(`the button counts the sessions still running or waiting (${label})`);
  else bad(`the button read "${label}"`);
  if (api.__cceScheduleCount() >= 2) ok('the sessions open the button even with no agent running');
  else bad('the button would stay hidden with only background sessions');

  sandbox.sigValue = (name) => (name === 'sessionId' ? 'someone-else' : undefined);
  calls.length = 0;
  if (api.__cceSchedule(h) === null) ok("another conversation's sessions are not shown here");
  else bad("another conversation's sessions leaked into this panel");

  sandbox.sigValue = (name) => (name === 'sessionId' ? SID : undefined);
  off2.on = true;
  calls.length = 0;
  const offTree = api.__cceSchedule(h);
  // The counts are held for half a second, so wait that out before asking the label again.
  const until = Date.now() + 600; while (Date.now() < until) { /* spin */ }
  if (offTree === null && api.__cceAgentsLabel('3 agents', 3) === '3 agents') ok('switched off, nothing is drawn or counted');
  else bad('the switch left the section or the count in place');

  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\ninstalled copy');
if (explicit.length) {
  /* Named bundles mean someone is asking about a build, not about this machine - the upstream check does exactly that.
     Counting a stale install as a failure there would report "an edit no longer matches" when every edit matched. */
  note('skipped: checking named bundles, not this machine');
} else {
  // The directory name VS Code gives an install, built from the manifest so a rename cannot leave this looking in the
  // wrong place - which would read as "not installed here" however many times the extension was installed.
  const mine = require('../package.json');
  const installed = extensionsDirs()
    .map((d) => path.join(d, `${mine.publisher}.${mine.name}-${mine.version}`))
    .find((d) => fs.existsSync(d));
  if (!installed) {
    note('this extension is not installed here; nothing to compare');
  } else {
    /* Reported, never counted. Packaging runs this check, and until the new package is installed the copy is behind by
       definition - failing here would make the build refuse to produce the very thing that fixes it. What matters is
       that a missing file is named out loud, because the extension cannot require what was never packaged and the only
       symptom on the next reload is that every addition silently disappears. */
    // The same list the parse check walks, so the two cannot drift apart - and it covers the entry point, without which
    // the extension does not activate at all.
    const here = sourceFiles();
    const missing = [], stale = [];
    for (const f of here) {
      const b = path.join(installed, f);
      if (!fs.existsSync(b)) missing.push(f);
      else if (fs.readFileSync(path.join(__dirname, '..', f), 'utf8') !== fs.readFileSync(b, 'utf8')) stale.push(f);
    }
    if (!missing.length && !stale.length) ok(`installed copy matches all ${here.length} source files`);
    if (missing.length) console.log(`  note  NOT INSTALLED YET: ${missing.join(', ')} - reinstall before reloading, or the extension will fail to activate`);
    if (stale.length) console.log(`  note  ${stale.length} of ${here.length} source files differ from the installed copy; reinstall to pick them up`);
  }
}

/* ── 6. everything shipped is written in English ──
   The .vsix goes to other people, so a string in the interface cannot end up in the language of whichever conversation
   happened to add it - and that is exactly the mistake nothing else here catches, because such a string works perfectly
   for the person who wrote it.

   Content is exempt by construction rather than by rule: a work plan's own words live in a file this extension only
   reads, so they never enter these files. The scan covers what build/pack.sh copies and nothing else - test/ is not
   shipped, and its fixtures carry non-ASCII on purpose to prove the encoding survives a round trip. */
console.log('\nshipped text');
{
  const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯！-｠]/;
  const TEXT = /\.(js|json|md|svg|py|sh|ya?ml|txt)$/;
  const root = path.join(__dirname, '..');
  /* What ships is read out of pack.sh rather than repeated here, so adding a path there cannot leave it unscanned.
     A second copy of that list is exactly the kind that drifts with nothing saying so. */
  const line = (fs.readFileSync(path.join(root, 'build', 'pack.sh'), 'utf8')
    .match(/^cp -r (.+) "\$stage\/extension\/"$/m) || [])[1];
  if (!line) bad('build/pack.sh no longer has a recognisable copy line, so what ships cannot be determined');
  else {
    const walk = (rel) => {
      if (!fs.statSync(path.join(root, rel)).isDirectory()) return TEXT.test(rel) ? [rel] : [];
      return fs.readdirSync(path.join(root, rel)).sort().flatMap((f) => walk(path.join(rel, f)));
    };
    const files = line.trim().split(/\s+/).flatMap(walk);
    const hits = [];
    for (const rel of files) {
      fs.readFileSync(path.join(root, rel), 'utf8').split('\n')
        .forEach((l, i) => { if (CJK.test(l)) hits.push(`${rel}:${i + 1}`); });
    }
    if (!hits.length) ok(`no CJK in any of the ${files.length} text files build/pack.sh ships`);
    else bad(`shipped files carry CJK, which reaches whoever installs this: ${hits.slice(0, 8).join(', ')}`);
  }

  /* Commit messages are not in the .vsix, so the scan above never sees them - and they travel anyway, because history
     goes with the repository. This is the only part of what gets published that nothing else guards.

     It runs over the whole history rather than the newest commit, since what is published is all of it. A message is
     worth catching BEFORE it is pushed: amending is a local edit, while rewriting pushed history is not, so the value
     of this check is entirely in running before the push. */
  const git = cp.spawnSync('git', ['-C', root, 'log', '--format=%B%x00'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    note('no git history to read here, so commit messages were not scanned');
  } else {
    const messages = git.stdout.split('\0').map((m) => m.trim()).filter(Boolean);
    const bads = messages.filter((m) => CJK.test(m))
      .map((m) => JSON.stringify(m.split('\n')[0].slice(0, 60)));
    if (!bads.length) ok(`no CJK in any of the ${messages.length} commit messages`);
    else bad(`commit messages carry CJK, and history travels with the repository: ${bads.slice(0, 4).join(', ')}`);
  }
}

/* ── 7. one limit on a description, spelled out in three places ──
   The view cuts a description at this length, a plugin hook refuses a write past it, and the skill quotes it to whoever
   is writing one. The three cannot import from each other - one is the extension, one is Python, one is prose - so the
   only thing that can hold them together is this.

   Drifting apart has a specific shape worth naming: a gate that refuses at one length while the view cuts at another is
   a gate nobody can satisfy, and the message it prints would state a number that is not the one being enforced. */
console.log('\none limit on a description');
{
  const root = path.join(__dirname, '..');
  const plan = require('../src/workplan');
  const hook = fs.readFileSync(
    path.join(root, 'claude-plugin', 'agent-work-plan', 'hooks', 'guard-work-plan.py'), 'utf8');
  const skill = fs.readFileSync(
    path.join(root, 'claude-plugin', 'agent-work-plan', 'skills', 'maintain', 'SKILL.md'), 'utf8');
  const num = (src, name) => {
    const m = new RegExp('^' + name + ' = (\\d+)$', 'm').exec(src);
    return m ? Number(m[1]) : null;
  };
  const quoted = /limited to (\d+) lines and (\d+) characters/.exec(skill);
  const want = [plan.MAX_DETAIL_LINES, plan.MAX_DETAIL_CHARS];
  const saw = {
    'the hook that refuses a write': [num(hook, 'MAX_DETAIL_LINES'), num(hook, 'MAX_DETAIL_CHARS')],
    'the skill that asks for it': quoted ? [Number(quoted[1]), Number(quoted[2])] : [null, null],
  };
  const off = Object.entries(saw)
    .filter(([, got]) => got[0] !== want[0] || got[1] !== want[1])
    .map(([who, got]) => `${who} says ${got[0]}/${got[1]}`);
  if (!off.length) ok(`all three say ${want[0]} lines and ${want[1]} characters`);
  else bad(`the view cuts at ${want[0]}/${want[1]} but ${off.join(', ')}`);
}

/* ── 8. deleting the plans of conversations that no longer exist ──
   The only code here that removes a file somebody wrote, so the cases that must NOT delete matter more than the one that
   must. Everything below runs against a directory made for the purpose; the real one is never named. */
console.log('\nabandoned work plans');
{
  const plan = require('../src/workplan');
  const OLD = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const NEW = Date.now();
  const id = (n) => `${n}${'0'.repeat(7)}-0000-0000-0000-000000000000`;

  /* A tree holding the transcripts named in `live`, a plan for each id in `plans`, and an offered-mark for each id in
     `marks` - all with the age given beside them. */
  const build = (live, plans, marks) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-sweep-'));
    const projects = path.join(root, 'projects');
    const dir = path.join(root, 'plans');
    fs.mkdirSync(path.join(projects, '-some-project'), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const s of live) fs.writeFileSync(path.join(projects, '-some-project', s + '.jsonl'), '{}\n');
    const age = (f, at) => fs.utimesSync(f, at / 1000, at / 1000);
    for (const [s, at] of plans) {
      const f = path.join(dir, s + '.json');
      fs.writeFileSync(f, '{"nodes":[]}');
      age(f, at);
    }
    for (const [s, at] of marks || []) {
      const f = path.join(dir, s + '.offered');
      fs.writeFileSync(f, '');
      age(f, at);
    }
    return { root, projects, dir };
  };
  const left = (dir) => fs.readdirSync(dir).sort();

  const cases = [
    ['an abandoned plan that has settled is deleted',
      () => build([id(1)], [[id(1), OLD], [id(2), OLD]]),
      (t, r) => r.deleted === 1 && r.kept === 1 && left(t.dir).join() === id(1) + '.json'],
    ['a plan whose conversation is still there is kept',
      () => build([id(1), id(2)], [[id(1), OLD], [id(2), OLD]]),
      (t, r) => r.deleted === 0 && r.kept === 2 && left(t.dir).length === 2],
    ['an abandoned plan written this week is kept',
      () => build([id(1)], [[id(2), NEW]]),
      (t, r) => r.deleted === 0 && r.kept === 1 && left(t.dir).length === 1],
    ['nothing is deleted when no transcript can be read',
      () => { const t = build([], [[id(1), OLD], [id(2), OLD]]); return t; },
      (t, r) => r.deleted === 0 && !!r.why && left(t.dir).length === 2],
    ['nothing is deleted when the transcript directory is missing',
      () => { const t = build([id(1)], [[id(2), OLD]]); fs.rmSync(t.projects, { recursive: true }); return t; },
      (t, r) => r.deleted === 0 && !!r.why && left(t.dir).length === 1],
    ['a sub-agent transcript does not count as a conversation',
      () => {
        const t = build([id(1)], [[id(2), OLD]]);
        const deep = path.join(t.projects, '-some-project', id(2), 'subagents');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'agent-abc.jsonl'), '{}\n');
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['a file that is not a plan is left where it is',
      () => {
        const t = build([id(1)], []);
        fs.writeFileSync(path.join(t.dir, 'notes.txt'), 'mine');
        fs.mkdirSync(path.join(t.dir, 'archive'));
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === 'archive,notes.txt'],
    /* The Stop hook leaves one of these behind for a conversation it offered a plan to and that never wrote one. It is
       the only trace such a conversation leaves, so nothing else would ever remove it. */
    ['the mark saying a plan was offered goes when its conversation does',
      () => build([id(1)], [], [[id(2), OLD]]),
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['that mark is kept while the conversation is still there',
      () => build([id(2)], [], [[id(2), OLD]]),
      (t, r) => r.deleted === 0 && r.kept === 1 && left(t.dir).join() === id(2) + '.offered'],
    ['and kept while it is younger than the settling time, like a plan',
      () => build([id(1)], [], [[id(2), NEW]]),
      (t, r) => r.deleted === 0 && r.kept === 1 && left(t.dir).length === 1],
    /* The list of detached sessions a conversation started describes that conversation, so it follows it out. */
    ['the list of sessions a conversation started goes when the conversation does',
      () => {
        const t = build([id(1)], []);
        const f = path.join(t.dir, id(2) + '.background');
        fs.writeFileSync(f, '{"ids":["1a2b3c4d"],"scannedTo":10}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['and is kept while the conversation is still there',
      () => {
        const t = build([id(2)], []);
        const f = path.join(t.dir, id(2) + '.background');
        fs.writeFileSync(f, '{"ids":["1a2b3c4d"],"scannedTo":10}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === id(2) + '.background'],
    /* The mark saying which turn a conversation is in. Rewritten every turn, so a live conversation's is always young;
       one that outlived its conversation is the only kind that gets old. */
    ['the mark of a conversation\'s current turn goes when the conversation does',
      () => {
        const t = build([id(1)], []);
        const f = path.join(t.dir, id(2) + '.turn');
        fs.writeFileSync(f, '{"prompt":"p","began":1}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 1 && left(t.dir).length === 0],
    ['and is kept while the conversation is still there',
      () => {
        const t = build([id(2)], []);
        const f = path.join(t.dir, id(2) + '.turn');
        fs.writeFileSync(f, '{"prompt":"p","began":1}');
        fs.utimesSync(f, OLD / 1000, OLD / 1000);
        return t;
      },
      (t, r) => r.deleted === 0 && left(t.dir).join() === id(2) + '.turn'],
  ];

  for (const [what, make, want] of cases) {
    const t = make();
    let r;
    try { r = plan.sweepOrphans({ dir: t.dir, projects: t.projects }); }
    catch (e) { bad(`${what}: threw ${e.message}`); fs.rmSync(t.root, { recursive: true, force: true }); continue; }
    if (want(t, r)) ok(what);
    else bad(`${what}: got ${JSON.stringify(r)} leaving ${JSON.stringify(left(t.dir))}`);
    fs.rmSync(t.root, { recursive: true, force: true });
  }
}

/* ── 9. one live stylesheet, several windows ──
   The file belongs to the Claude Code install; an extension host belongs to a window, and every one of them writes it.
   Two windows that disagree about its content put their own version back in turn, and the panel reloads the stylesheet
   each time - which is a setting that appears and disappears on a timer. A regression here is silent, hence these. */
console.log('\none live stylesheet, several windows');
{
  const tasks = require('../src/tasks');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-live-'));
  const project = (name, n, tag) => {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    const list = [];
    for (let i = 0; i < n; i++) list.push({ id: tag + i, cron: '* * * * *', createdBySessionId: 's-' + tag });
    fs.writeFileSync(path.join(d, '.claude', 'scheduled_tasks.json'), JSON.stringify({ tasks: list }));
    return d;
  };

  /* The directories reach this most recently opened first, so their order differs per window. */
  const a = project('alpha', 1, 'a'), b = project('beta', 1, 'b');
  if (JSON.stringify(tasks.readTasks([a, b])) === JSON.stringify(tasks.readTasks([b, a]))) {
    ok('two windows listing the same projects in a different order agree');
  } else bad('the task list still follows the order the directories arrived in');

  /* Stronger: with more tasks than the cap, WHICH of them survive must not depend on that order either. */
  const c = project('gamma', tasks.MAX_TASKS - 5, 'g'), e = project('delta', tasks.MAX_TASKS - 5, 'd');
  if (JSON.stringify(tasks.readTasks([c, e])) === JSON.stringify(tasks.readTasks([e, c]))) {
    ok(`at the cap of ${tasks.MAX_TASKS}, which tasks survive does not depend on that order either`);
  } else bad('at the cap, the surviving tasks still depend on the order the directories arrived in');

  const wv = path.join(root, 'webview');
  fs.mkdirSync(wv, { recursive: true });
  const css = path.join(wv, 'claude-code-extras.css');
  const ours = require('../package.json').version;
  const head = () => fs.readFileSync(css, 'utf8').split('\n')[0];
  const opts = { enabled: true, userEdge: true };

  if (webview.writeLive(root, opts) && head().includes(ours)) ok('the stylesheet records which build wrote it');
  else bad('the stylesheet does not carry the writing build, so nothing can tell two of them apart');

  if (webview.writeLive(root, opts) === false) ok('the same settings again writes nothing');
  else bad('an unchanged stylesheet is rewritten, which reloads it in every panel');

  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('Extras ' + ours, 'Extras 9.9.9'));
  if (webview.writeLive(root, { enabled: true, userEdge: false }) === false && head().includes('9.9.9')) {
    ok('what a newer build wrote is left alone');
  } else bad('an older build overwrites a newer one, which is the flicker this prevents');

  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('Extras 9.9.9', 'Extras 0.0.1'));
  if (webview.writeLive(root, opts) === true && head().includes(ours)) ok('what an older build wrote is taken over');
  else bad('an older build keeps the file, so an upgrade never reaches the panel');

  fs.writeFileSync(css, '/* Claude Code Extras live settings - written by the extension */\n');
  if (webview.writeLive(root, opts) === true) ok('a file from before this rule is taken over');
  else bad('a stylesheet carrying no version is never replaced');

  /* And the part that does not depend on winning that race at all. A build old enough to predate the version rule
     overwrites the file without knowing what it dropped, and nothing written today stops a host that is already running
     - so the bar on your own messages is carried by the injected script, switched by a property that counts as on when
     it is absent. That is what makes an older build unable to turn it off. */
  const edge = webview.SCRIPT.includes('var EDGE_CSS =');
  const onByDefault = /var\(--cce-edge,\s*1\)/.test(webview.SCRIPT);
  const notInSheet = !webview.liveCss({ enabled: true, userEdge: true }).includes('--cce-edge');
  const offWhenAsked = webview.liveCss({ enabled: true, userEdge: false }).includes('--cce-edge:0');
  if (edge && onByDefault && notInSheet && offWhenAsked) {
    ok('the bar is in the injected script and defaults to on, so an older build cannot drop it');
  } else {
    bad('the bar depends on the shared stylesheet again'
      + ` (in script: ${edge}, defaults on: ${onByDefault}, absent when on: ${notInSheet}, off when asked: ${offWhenAsked})`);
  }

  fs.rmSync(root, { recursive: true, force: true });
}

/* ── 10. what is left to do, drawn first ──
   A plan only grows, so in the file's own order the few rows that still need doing scatter among the many that are done.
   The drawing separates them; what must survive that is the row's id, because it is all the view has to remember which
   branches were open - an id that changed because a row moved would fold the tree up as work got done. */
console.log('\nwhat is left to do, drawn first');
{
  const plan = require('../src/workplan');
  const N = (title, state) => ({ title, state });
  const titles = (rows) => rows.map((r) => r.title).join(',');

  const mixed = [N('a', 'done'), N('b', 'todo'), N('c', 'dropped'), N('d', 'discussing'), N('e', 'done'), N('f', 'parked')];
  if (titles(plan.openFirst(mixed)) === 'f,d,b,e,c,a') ok('unfinished rows come first, newest first within each group');
  else bad(`the drawn order is ${titles(plan.openFirst(mixed))}, expected f,d,b,e,c,a`);

  /* A row being worked on is unfinished, so it belongs in the front group. Leaving it out of the open list would drop it
     from what is injected, and a row nobody is reminded of is the one that gets abandoned. */
  const withDoing = [N('a', 'done'), N('b', 'doing'), N('c', 'todo')];
  if (titles(plan.openFirst(withDoing)) === 'c,b,a' && plan.OPEN_STATES.includes('doing')) {
    ok('a row being worked on counts as open and is drawn with the unfinished ones');
  } else bad(`doing sorted to ${titles(plan.openFirst(withDoing))}, open states ${plan.OPEN_STATES.join()}`);

  /* An unknown state falls back to todo, so a plan written by a newer build stays readable rather than half-rendering. */
  if (plan.STATES.length === 7 && plan.STATES.includes('doing') && plan.STATES.includes('waiting')) {
    ok('seven states, doing and waiting among them');
  } else bad(`the states are ${plan.STATES.join()}`);

  /* A row waiting on somebody is still unfinished, so it is drawn and injected with the rest of the open work. */
  const withWaiting = [N('a', 'done'), N('b', 'waiting'), N('c', 'todo')];
  if (titles(plan.openFirst(withWaiting)) === 'c,b,a' && plan.OPEN_STATES.includes('waiting')) {
    ok('a row waiting on somebody counts as open');
  } else bad(`waiting sorted to ${titles(plan.openFirst(withWaiting))}, open states ${plan.OPEN_STATES.join()}`);

  /* Nothing to separate still means newest first: the two groups are an ordering on top of that, not instead of it. */
  const allDone = [N('a', 'done'), N('b', 'dropped')];
  const allOpen = [N('a', 'todo'), N('b', 'parked')];
  if (titles(plan.openFirst(allDone)) === 'b,a' && titles(plan.openFirst(allOpen)) === 'b,a') {
    ok('a list with nothing to separate is still drawn newest first');
  } else bad(`all-closed gave ${titles(plan.openFirst(allDone))}, all-open ${titles(plan.openFirst(allOpen))}`);

  if (titles(plan.openFirst([])) === '' && titles(plan.openFirst(null)) === '') ok('no rows, and no rows at all, are fine');
  else bad('an empty or missing list is not handled');

  /* The id is built from the row's place in the file, so closing a row moves it on screen without renaming it. */
  const rowsOf = (nodes) => plan.openFirst(
    nodes.map((n, i) => ({ node: n, key: 'p/' + i + ':' + n.title })), (r) => r.node.state);
  const idOf = (rows, t) => (rows.find((r) => r.node.title === t) || {}).key;
  /* Newest first, so closing the LAST row is what moves it: c leads while open and trails once closed. */
  const before = rowsOf([N('a', 'todo'), N('b', 'todo'), N('c', 'todo')]);
  const after = rowsOf([N('a', 'todo'), N('b', 'todo'), N('c', 'done')]);
  const moved = before.indexOf(before.find((r) => r.node.title === 'c'))
    !== after.indexOf(after.find((r) => r.node.title === 'c'));
  if (moved && idOf(before, 'c') === idOf(after, 'c') && idOf(before, 'b') === idOf(after, 'b')) {
    ok('a row that closes moves on screen and keeps its id');
  } else bad(`closing a row renames it (moved: ${moved}, was ${idOf(before, 'c')}, now ${idOf(after, 'c')})`);

  /* The number a person says out loud, which the tree and the injected rows both show. It comes from the file for the
     same reason the id does, so finishing something does not renumber what is left - dense numbering over the visible
     rows alone would mean a number quoted an hour ago points at a different row now. */
  const cp = require('child_process');
  const hook = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'inject-work-plan.py');
  const numbersRaw = (nodes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-raw-'));
    const session = '41000000-0000-0000-0000-000000000000';
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [hook, dir], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return ''; }
  };
  const numbers = (nodes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-num-'));
    const session = '40000000-0000-0000-0000-000000000000';
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [hook, dir], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    let said = '';
    try { said = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return []; }
    /* The dot after the number is part of what is drawn, so it is matched and kept out of the capture. */
    return said.split('\n').map((l) => (/^\s*[?o=+x] ([0-9.]+)\. /.exec(l) || [])[1]).filter(Boolean);
  };
  {
    const got = numbers([
      N('one', 'todo'),
      Object.assign(N('two', 'todo'), { children: [N('two-a', 'todo'), N('two-b', 'todo')] }),
      N('three', 'todo'),
    ]);
    if (got.join(',') === '3,2,2.2,2.1,1') ok('numbers come from the file while the rows are drawn newest first');
    else bad(`the numbering came out ${JSON.stringify(got)}`);
  }
  {
    /* The one instruction that has to arrive before the work rather than after it. Left to the skill alone it reaches an
       agent only when the description happens to match; here it arrives every turn, which is the difference between the
       state being used and being decoration. */
    const said = numbersRaw([N('one', 'todo')]);
    if (said.includes('`doing` as you start on it')) ok('the injected block asks for doing before the work, every turn');
    else bad(`the injected block does not mention doing: ${JSON.stringify(said.slice(0, 160))}`);
  }
  {
    /* Closing the first row must not move the numbers of the rest. */
    const open = numbers([N('one', 'todo'), N('two', 'todo'), N('three', 'todo')]);
    const closed = numbers([N('one', 'done'), N('two', 'todo'), N('three', 'todo')]);
    if (open.join(',') === '3,2,1' && closed.join(',') === '3,2') {
      ok('a row that closes leaves a gap rather than renumbering what follows');
    } else bad(`before ${JSON.stringify(open)}, after closing the first ${JSON.stringify(closed)}`);
  }
}

/* ── 11. what the Stop hook says, and how often ──
   The hook is the only part of the plugin that can start a plan existing, because until one does the injection has
   nothing to inject and the skill is found only when its description happens to match. Both halves of that are worth
   a test: it has to speak on a conversation keeping no plan, and it has to do so exactly once. Run as a process, since
   the thing under test is the whole script including the marker it writes. */
console.log('\nwhat the Stop hook says, and how often');
{
  const hook = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'nudge-work-plan.py');
  const session = '30000000-0000-0000-0000-000000000000';

  /* `turns` messages from the user, the last of them followed by `tools` calls. The hook walks the transcript backwards
     to that last message for the turn, and over the whole tail for how many times the user has spoken. */
  const stage = (tools, plan, turns = 3, limits) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-nudge-'));
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    const transcript = path.join(dir, 'transcript.jsonl');
    const lines = [];
    for (let t = 0; t < turns; t++) {
      lines.push(JSON.stringify({
        type: 'user', timestamp: `2026-01-01T00:0${t}:00.000Z`, message: { content: 'go' },
      }));
      if (t < turns - 1) lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
    }
    for (let i = 0; i < tools; i++) {
      // Write rather than Read: the reminder counts what a turn CHANGED, so a turn of reads owes the plan nothing.
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }));
    }
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
    if (plan) {
      const f = path.join(data, session + '.json');
      fs.writeFileSync(f, JSON.stringify(plan));
      const back = Date.parse('2025-01-01T00:00:00Z') / 1000;
      fs.utimesSync(f, back, back);
    }
    if (limits) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(limits));
    return { dir, data, transcript };
  };
  const run = (t) => {
    const r = cp.spawnSync('python3', [hook, t.data], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' }),
    });
    const said = (r.stdout || '').trim();
    return { said, marked: fs.existsSync(path.join(t.data, session + '.offered')), status: r.status };
  };

  {
    const t = stage(30, null);
    const first = run(t), second = run(t);
    if (first.said.includes('keeping no work plan') && first.marked) ok('a busy turn with no plan at all is told it could keep one');
    else bad(`a busy turn with no plan said ${JSON.stringify(first.said.slice(0, 80))}, marked ${first.marked}`);
    if (!second.said) ok('and is not told a second time');
    else bad(`the offer repeats: ${JSON.stringify(second.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(5, null);
    const r = run(t);
    if (!r.said && !r.marked) ok('a small turn with no plan is left alone, and no mark is spent on it');
    else bad(`a 5-tool turn was spoken to: ${JSON.stringify(r.said.slice(0, 80))}, marked ${r.marked}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    const r = run(t);
    if (r.said.includes('neither read nor updated')) ok('a plan left untouched by the turn is still the other message');
    else bad(`an untouched plan said ${JSON.stringify(r.said.slice(0, 80))}`);
    /* Stop fires more than once in a single exchange - eight times in one, in the conversation this was measured in -
       so without this the reminder arrives in bursts, and a burst is what taught the reader to skip it. Saying it again
       about a plan in the same state adds nothing: a reminder that did not work the first time does not work fifth. */
    const again = [run(t), run(t), run(t)].filter((x) => x.said).length;
    if (!again) ok('and is not repeated while the plan stays in that state');
    else bad(`the reminder repeated ${again} more times in the same turn`);
    /* Once the plan has moved on, forgetting again has to be catchable again. */
    const at = path.join(t.data, session + '.json');
    // Later than when the reminder last spoke, still earlier than the turn - a plan newer than the turn is already left
    // alone by the condition above, so testing against a current timestamp would prove nothing about this one.
    const moved = Date.parse('2025-06-01T00:00:00Z') / 1000;
    fs.utimesSync(at, moved, moved);
    if (run(t).said) ok('and comes back once the plan has been written to since');
    else bad('the reminder stayed silent after the plan changed');
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* What the threshold is really asking is whether the turn changed anything, not how busy it looked. A turn of reading
     and measuring makes plenty of calls and owes the plan nothing - 18 of 29 reminders went to turns like this one. */
  {
    const t = stage(0, { nodes: [{ title: 'x', state: 'todo' }] });
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(t.transcript, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "grep -rn foo . | sed 's/^/  /'" } }] },
      }) + '\n');
    }
    const r = run(t);
    if (!r.said) ok('a turn of twenty read-only commands is not reminded of anything');
    else bad(`a read-only turn said ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* Which shell commands count as changing something, by example. `>` means a redirect to a shell and a comparison to
     everything else, and a heredoc script arrives as one argument so both meanings sit in the same string - a `count >= 4`
     inside an embedded script read as a write and put the reminder back on turns that had changed nothing. Only examples
     hold a judgement like this; a description of the pattern would have looked correct in that state too. */
  {
    const reads = [
      'python3 -c "if n >= 4: print(1)"',
      'python3 -c "if a <= b and c => d: pass"',
      "grep -c foo bar | sed 's/^/  /'",
      'node test/check.js 2>&1 | tail -1',
      'ls -d ~/x > /dev/null 2>&1; echo ok',
      'git log --format="%h" -S "foo" | tail -3',
      'git status --short',
    ];
    const writes = [
      'echo hi > /tmp/a', 'echo hi >> notes.txt', 'git commit -m x', 'git add .',
      'cp a b', 'rm -rf build', 'sed -i "s/a/b/" f', 'mkdir -p out && touch out/x',
    ];
    const judge = (command) => {
      const t = stage(0, { nodes: [{ title: 'x', state: 'todo' }] });
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(t.transcript, JSON.stringify({
          type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
        }) + '\n');
      }
      const said = !!run(t).said;
      fs.rmSync(t.dir, { recursive: true, force: true });
      return said;
    };
    const wrongly = reads.filter(judge);
    const missed = writes.filter((c) => !judge(c));
    if (!wrongly.length) ok(`${reads.length} read-only commands are all seen as changing nothing`);
    else bad(`read-only commands counted as changes: ${JSON.stringify(wrongly)}`);
    if (!missed.length) ok(`${writes.length} writing commands are all seen as changes`);
    else bad(`writing commands counted as read-only: ${JSON.stringify(missed)}`);
  }
  /* Reading the plan has to count, or the reminder cannot be answered at all: reading leaves no mark on the file, so a
     turn that looked and a turn that forgot look identical from the file's age, and the reminder repeats for the rest of
     a conversation whose plan is already correct. */
  {
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    const at = path.join(t.data, session + '.json');
    fs.appendFileSync(t.transcript, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: at } }] },
    }) + '\n');
    const r = run(t);
    if (!r.said) ok('a turn that read the plan and changed nothing is left alone');
    else bad(`reading the plan still drew ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  /* The trap in counting a read: this plugin injects the plan's own path at the top of every turn, so looking for the
     path anywhere in the turn would find it every time and the reminder could never fire. Only the calls the assistant
     made are searched. */
  {
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    const at = path.join(t.data, session + '.json');
    const lines = fs.readFileSync(t.transcript, 'utf8').trimEnd().split('\n');
    lines[0] = JSON.stringify({
      type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: `the file is ${at}\ngo` },
    });
    fs.writeFileSync(t.transcript, lines.join('\n') + '\n');
    const r = run(t);
    if (r.said.includes('neither read nor updated')) ok('the path appearing in injected context is not mistaken for a read');
    else bad(`injected context silenced the reminder: ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* The case this gate exists for. A session handed one task and left to do it burns tool calls on a single strand and
       cannot branch, so a plan has nothing to hold - and 53 of 61 offers went to exactly that. Offering anyway costs the
       sentence and teaches whoever reads it that the sentence can be skipped, which is what the offer had left to lose. */
    const t = stage(40, null, 1);
    const r = run(t);
    if (!r.said && !r.marked) ok('a busy single-turn worker is not offered a plan, and no mark is spent on it');
    else bad(`a single-turn worker was offered one: ${JSON.stringify(r.said.slice(0, 80))}, marked ${r.marked}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* Both thresholds come from the file the extension writes, and the editor's settings are the only place to edit it. */
    const t = stage(40, null, 2, { offerMinTurns: 9 });
    const r = run(t);
    const u = stage(40, null, 2, { offerMinTurns: 2 });
    const ru = run(u);
    if (!r.said && ru.said.includes('keeping no work plan')) ok('the turn threshold is read from the settings file, either way');
    else bad(`raising it said ${JSON.stringify(r.said.slice(0, 60))}, lowering it said ${JSON.stringify(ru.said.slice(0, 60))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
    fs.rmSync(u.dir, { recursive: true, force: true });
  }
  {
    /* A session that keeps no transcript - `claude -p --no-session-persistence` is one - still runs this hook, with a
       path to a file that was never written. A traceback here is drawn in the panel as a failed Stop hook. */
    const t = stage(10, { nodes: [{ title: 'x', state: 'todo' }] });
    fs.rmSync(t.transcript);
    const r = run(t);
    if (r.status === 0 && !r.said) ok('a transcript that cannot be read leaves the hook silent, not failing');
    else bad(`with no transcript the hook exited ${r.status} and said ${JSON.stringify(r.said.slice(0, 120))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* A file that is not there, or is nonsense, leaves the plugin on its own defaults - it ships without this extension. */
    const t = stage(40, null, 3, { offerMinTurns: 'lots', offerMinToolCalls: 0 });
    const r = run(t);
    if (r.said.includes('keeping no work plan')) ok('a nonsense settings file is ignored rather than obeyed');
    else bad(`nonsense settings changed the outcome: ${JSON.stringify(r.said.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
}

/* ── 12. the waiting, paired out of the official extension's log ──
   Every figure this produces is a subtraction between two lines that are far apart, so the risk is not arithmetic: it
   is pairing the wrong two. A trigger that never matches reports nothing and looks like a fast machine, and a gap that
   is really someone leaving the window alone reports minutes that nobody waited. Both are tested here. */
console.log('\nthe waiting, paired out of the official log');
{
  const L = require('../src/openlatency');
  const at = (clock, msg) => `2026-09-29 21:0${clock} [info] ${msg}`;
  const clicked = 'Received message from webview: {"type":"request","requestId":"a","request":{"type":"open_in_editor","sessionId":"s"}}';
  const up = 'Received message from webview: {"type":"request","requestId":"b","request":{"type":"init"}}';

  const one = (text) => L.readOut(text).waits;
  const only = (text, what) => one(text).filter((r) => r.what === what);

  {
    const got = only([at('0:00.000', clicked), at('0:30.000', up)].join('\n'), 'panel');
    if (got.length === 1 && got[0].waited === 30000 && got[0].trigger === 'click') ok('a panel asked for and slow to answer is 30s under "click"');
    else bad(`a clicked panel measured ${JSON.stringify(got)}`);
  }
  {
    const text = [at('0:00.000', 'Claude code extension is now active?'), at('0:20.000', up)].join('\n');
    const got = only(text, 'panel');
    if (got.length === 1 && got[0].waited === 20000 && got[0].trigger === 'window') ok('a panel the window restored is timed from activation');
    else bad(`a restored panel measured ${JSON.stringify(got)}`);
  }
  {
    /* A fast open still has to come out of readOut - it is the denominator - and then be counted rather than recorded. */
    const waits = one([at('0:00.000', clicked), at('0:00.900', up)].join('\n'));
    const { slow, fast } = L.split(waits, 10000);
    if (waits.length === 1 && !slow.length && fast['panel/click'] === 1) {
      ok('a fast open is counted, not recorded, so an ordinary day does not fill the file');
    } else bad(`a 0.9s open gave slow ${JSON.stringify(slow)} fast ${JSON.stringify(fast)}`);
  }
  {
    /* The threshold decides which side a wait falls on, and nothing else about it. */
    const waits = [
      { what: 'panel', trigger: 'click', waited: 9999 },
      { what: 'panel', trigger: 'click', waited: 10000 },
      { what: 'host', trigger: 'x', waited: 3000 },
    ];
    const { slow, fast } = L.split(waits, 10000);
    if (slow.length === 1 && slow[0].waited === 10000 && fast['panel/click'] === 1 && !fast['host/x']) {
      ok('the threshold is inclusive, and a short host gap is dropped rather than counted');
    } else bad(`split gave slow ${JSON.stringify(slow)} fast ${JSON.stringify(fast)}`);
  }
  {
    /* The day's count must reach the file, and as one line rather than one per open. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat5-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    const fastPair = (m) => [at(`${m}:00.000`, clicked), at(`${m}:00.500`, up)].join('\n');
    fs.writeFileSync(log, [fastPair(0), fastPair(1), fastPair(2)].join('\n') + '\n');
    const day1 = Date.parse('2026-09-29T12:00:00Z');
    const r1 = L.sample({ log, dir, state: {}, version: 'v1', now: day1, pid: 606, thresholdMs: 10000 });
    if (!r1.added.length && r1.state.counts['panel/click'] === 3 && !fs.existsSync(L.recordFile(dir, 606))) {
      ok('three fast opens write nothing yet and are held as a count of three');
    } else bad(`fast opens gave added ${r1.added.length}, counts ${JSON.stringify(r1.state.counts)}`);

    /* The next day, the finished one goes out. */
    fs.appendFileSync(log, [at('5:00.000', clicked), at('5:20.000', up)].join('\n') + '\n');
    const r2 = L.sample({
      log, dir, state: r1.state, version: 'v1', now: day1 + 24 * 3600 * 1000, pid: 606, thresholdMs: 10000,
    });
    const recs = L.readRecords(L.recordFile(dir, 606));
    const tally = recs.filter((x) => x.what === 'tally');
    if (tally.length === 1 && tally[0].day === '2026-09-29' && tally[0].counts['panel/click'] === 3
        && r2.added.length === 1 && r2.added[0].waited === 20000) {
      ok('when the day turns its count goes out as one line, beside the slow wait itself');
    } else bad(`day turn left ${JSON.stringify(recs)}`);

    const rows = L.summarise(recs);
    const click = rows.find((x) => x.what === 'panel' && x.trigger === 'click');
    if (click && click.n === 1 && click.fast === 3) ok('the summary shows one slow open against three fast ones');
    else bad(`summarise gave ${JSON.stringify(rows)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  /* The host-busy watcher is temporary and spread over three files, so each place that carries it has to say so. A
     diagnostic whose own code no longer admits to being one is a diagnostic nobody will ever remove: the comment is the
     only thing that licenses deleting it, and by the time anyone wonders, the investigation it belongs to will be months
     past. Checked rather than trusted because the three are easy to edit apart. */
  {
    const marked = [
      ['src/openlatency.js', 'TEMPORARY, FOR ONE INVESTIGATION'],
      ['extension.js', 'TEMPORARY, FOR ONE INVESTIGATION'],
      ['src/page/99-sweep.js', 'TEMPORARY, part of one investigation'],
      ['src/openlatency.js', 'TEMPORARY, part of the investigation at writeAtomic'],
      ['extension.js', 'TEMPORARY, part of that same investigation'],
    ];
    const bare = marked.filter(([f, mark]) =>
      !fs.readFileSync(path.join(__dirname, '..', f), 'utf8').includes(mark));
    if (!bare.length) ok(`all ${marked.length} parts of the host-busy diagnostic say they are temporary`);
    else bad(`no longer marked temporary, so nothing licenses removing it: ${bare.map(([f]) => f).join(', ')}`);
  }

  /* Whether this extension host was running during a wait, which the wait alone cannot say: silence either side of a long
     one means either the host was blocked and could not act, or it was idle with nothing to act on, and those are opposite
     halves of the machine. A clock read on a timer tells them apart. Folding consecutive overruns matters as much as
     noticing them - a host stalled for a minute would otherwise write sixty records of one stall. */
  {
    let t = 1000000;
    const w = L.lagWatcher({ now: () => t, write: false, version: 'v1' });
    const step = (ms) => { t += ms; return w.tick(); };
    step(1000); step(1000);                        // on time: nothing to say
    if (!w.records.length && !w.open) ok('a timer arriving on time records nothing');
    else bad(`an on-time timer produced ${JSON.stringify(w.records)}`);

    step(1000 + 5000);                             // five seconds late
    step(1000 + 30000);                            // thirty more, same stretch
    if (w.open && !w.records.length) ok('a stretch of delay is held open rather than written once per tick');
    else bad(`mid-stall state was ${JSON.stringify({ open: w.open, records: w.records })}`);

    step(1000);                                    // on time again, so the stretch closes
    const r = w.records[0];
    if (w.records.length === 1 && r.what === 'hostbusy' && r.blocked === 35000 && r.ticks === 2) {
      ok('it comes out as one record naming the whole span');
    } else bad(`the closed stretch was ${JSON.stringify(w.records)}`);

    // The report has to put the two kinds together, since reading one against the other is the entire point.
    const together = L.report([
      { what: 'panel', trigger: 'window', waited: 94297, version: 'v1', at: '2026-10-01T01:05:22.831Z' }, r,
    ]).join('\n');
    if (together.includes('busy') && together.includes('waiting on the panel')) {
      ok('the report lists host-busy stretches beside the waits, and says what no overlap means');
    } else bad('the report did not mention both kinds');

    const alone = L.report([{ what: 'panel', trigger: 'window', waited: 94297, version: 'v1', at: 'x' }]).join('\n');
    if (alone.includes('waiting on the panel rather than on this side')) ok('with no busy stretch it says so outright');
    else bad('a report with no busy stretch left the reader to infer it');
  }
  /* Replacing a patched file during startup is the leading suspect for a panel that takes minutes to open, so the write
     has to be recorded with its offset into startup - the wall clock cannot say whether it landed while the panel was
     still reading. Written every time rather than past a threshold: a write that did NOT coincide with a slow open is
     exactly as informative, and which of the two happens is the whole question. */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-patchrec-'));
    const r = L.patchRecord({ dir, version: 'v1', target: 'Claude Code panel', intoStartup: 1840, took: 95,
      at: '2026-10-01T05:00:00.000Z', pid: 999 });
    const back = L.readAll(dir);
    if (r && back.length === 1 && back[0].what === 'patched' && back[0].intoStartup === 1840 && back[0].took === 95) {
      ok('replacing a patched file is recorded with its offset into startup and how long it took');
    } else bad(`the write record came back as ${JSON.stringify(back)}`);

    const withWait = L.report(back.concat([
      { what: 'panel', trigger: 'window', waited: 94297, version: 'v1', at: '2026-10-01T05:00:01.000Z' },
    ])).join('\n');
    if (withWait.includes('into startup') && withWait.includes('script reached at')) {
      ok('and is printed against the waits, pointing at the panel number to compare it with');
    } else bad('the report did not put the write beside the waits');

    const none = L.report([{ what: 'panel', trigger: 'window', waited: 94297, version: 'v1', at: 'x' }]).join('\n');
    if (none.includes('no patched file has been replaced')) ok('a window that wrote nothing and still waited says so, which rules the write out');
    else bad('a report with no write left the reader to infer it');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    /* Closing the window is the other moment the count is complete; losing it would lose the denominator. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat6-'));
    const n = L.flush({ dir, state: { day: '2026-09-29', version: 'v1', counts: { 'panel/click': 5 } }, pid: 707 });
    const recs = L.readRecords(L.recordFile(dir, 707));
    if (n === 5 && recs.length === 1 && recs[0].counts['panel/click'] === 5) ok('closing the window writes the day\'s count out');
    else bad(`flush returned ${n} leaving ${JSON.stringify(recs)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const text = ['2026-09-29 20:00:00.000 [info] ' + clicked, '2026-09-29 21:00:00.000 [info] ' + up].join('\n');
    if (!only(text, 'panel').length) ok('an hour of silence is treated as a window left alone, not as an hour of waiting');
    else bad('an hour-long gap was recorded as a wait');
  }
  {
    /* Two panels coming up after one click: the second must not be credited with the first one's wait. */
    const got = only([at('0:00.000', clicked), at('0:30.000', up), at('1:10.000', up)].join('\n'), 'panel');
    if (got.length === 1 && got[0].waited === 30000) ok('a second panel is not credited with the first one\'s wait');
    else bad(`two panels after one click measured ${JSON.stringify(got)}`);
  }
  {
    /* A gap that ends at a webview message belongs to the pairing above; counting it as host silence too would double it. */
    const got = one([at('0:00.000', clicked), at('0:30.000', up)].join('\n')).filter((r) => r.what === 'host');
    if (!got.length) ok('the same silence is not also counted as the host being idle');
    else bad(`the gap was double-counted: ${JSON.stringify(got)}`);
  }
  {
    const spawn = 'Spawning Claude with SDK query function - cwd: /x, permission mode: default, version: 2.1.1, /bin/claude, resume: undefined';
    const said = 'From claude: 2026-09-29T21:00:05.000Z [DEBUG] hello';
    const got = only([at('0:00.000', spawn), at('0:05.000', said)].join('\n'), 'cli');
    if (got.length === 1 && got[0].waited === 5000 && got[0].trigger === 'new') ok('a CLI slow to print its first line is timed as "new"');
    else bad(`a slow CLI spawn measured ${JSON.stringify(got)}`);
  }
  {
    const dir = path.join('/a', 'logs', '20260101T000000', 'exthost7', 'xnervwang.claude-code-extras');
    const want = path.join('/a', 'logs', '20260101T000000', 'exthost7', 'Anthropic.claude-code', 'Claude VSCode.log');
    if (L.logFile(dir) === want) ok('their log is found as a sibling of ours, not by taking the newest directory');
    else bad(`logFile gave ${L.logFile(dir)}`);
  }
  {
    /* Sampling twice must not count the same wait twice, and the second read starts mid-line. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    fs.writeFileSync(log, [at('0:00.000', clicked), at('0:30.000', up)].join('\n') + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', pid: 11 });
    fs.appendFileSync(log, [at('2:00.000', clicked), at('2:40.000', up)].join('\n') + '\n');
    const second = L.sample({ log, dir, state: first.state, version: 'v1', pid: 11 });
    const waits = L.readAll(dir).filter((r) => r.what === 'panel').map((r) => r.waited).sort((a, b) => a - b);
    if (first.added.length === 1 && second.added.length === 1 && waits.join() === '30000,40000') {
      ok('a second pass reads only what was appended, and the records are the union');
    } else bad(`two passes gave ${first.added.length} then ${second.added.length}, records ${JSON.stringify(waits)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* Two windows, each with its own log, writing at the same time. Sharing one record file loses whichever wrote
       first, so this is the check that says they are not sharing it. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat2-'));
    const dir = path.join(root, 'rec');
    const one = path.join(root, 'a.log'), two = path.join(root, 'b.log');
    fs.writeFileSync(one, [at('0:00.000', clicked), at('0:30.000', up)].join('\n') + '\n');
    fs.writeFileSync(two, [at('1:00.000', clicked), at('1:50.000', up)].join('\n') + '\n');
    L.sample({ log: one, dir, state: {}, version: 'v1', pid: 101 });
    L.sample({ log: two, dir, state: {}, version: 'v1', pid: 202 });
    const waits = L.readAll(dir).filter((r) => r.what === 'panel').map((r) => r.waited).sort((a, b) => a - b);
    const files = fs.readdirSync(dir).sort();
    if (waits.join() === '30000,50000' && files.join() === 'open-latency-101.jsonl,open-latency-202.jsonl') {
      ok('two windows keep both sets of records, in a file each');
    } else bad(`two windows left ${JSON.stringify(files)} holding ${JSON.stringify(waits)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* A window that is gone leaves its file behind; without pruning a machine collects one per host it ever ran. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat3-'));
    const old = L.recordFile(dir, 303), mine = L.recordFile(dir, 404);
    for (const f of [old, mine]) fs.writeFileSync(f, JSON.stringify({ what: 'panel', waited: 2000, at: 'x' }) + '\n');
    const back = (Date.now() - L.STALE_MS - 60000) / 1000;
    fs.utimesSync(old, back, back);
    const gone = L.prune(dir, Date.now(), mine);
    const left = fs.readdirSync(dir);
    if (gone === 1 && left.join() === path.basename(mine)) ok('a long-dead window\'s file is removed and this one\'s is not');
    else bad(`prune removed ${gone}, leaving ${JSON.stringify(left)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    /* Trimming must not throw away the newest records, which is the only thing it could get wrong. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat4-'));
    const f = L.recordFile(dir, 505);
    const rows = [];
    for (let i = 0; i < L.TRIM_AT + 10; i++) rows.push(JSON.stringify({ what: 'panel', waited: i, at: String(i) }));
    fs.writeFileSync(f, rows.join('\n') + '\n');
    const dropped = L.trim(f);
    const kept = L.readRecords(f);
    if (kept.length === L.KEEP && kept[kept.length - 1].waited === L.TRIM_AT + 9 && dropped === rows.length - L.KEEP) {
      ok('trimming keeps the newest and says how many it dropped');
    } else bad(`trim left ${kept.length} ending at ${kept.length && kept[kept.length - 1].waited}, dropped ${dropped}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    /* The failure this whole design turns on: a wait longer than the gap between two reads has its start in one piece of
       log and its end in another. Pairing that only lived inside one read dropped every one of them, which meant it
       dropped exactly the waits worth recording and kept the short ones. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat7-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    /* `now` has to sit near the log's own clock, or the pending request is older than the ceiling and gets written off
       as one that never arrived - which is the other new behaviour, not this one. */
    const t0 = Date.parse('2026-09-29T21:00:05Z');
    fs.writeFileSync(log, at('0:00.000', clicked) + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 808, thresholdMs: 10000 });
    fs.appendFileSync(log, at('1:30.000', up) + '\n');
    const second = L.sample({
      log, dir, state: first.state, version: 'v1', now: t0 + 95000, pid: 808, thresholdMs: 10000,
    });
    if (!first.added.length && first.state.pending.asked
        && second.added.length === 1 && second.added[0].waited === 90000) {
      ok('a wait split across two reads is still paired, and measures 90s');
    } else bad(`split across reads gave ${first.added.length} then ${JSON.stringify(second.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* Clicking again long after the first attempt never opened: the abandoned one has to be recorded, and the new one
       timed from the new click rather than the old. Without this the total someone actually sat through is nowhere. */
    const waits = one([at('0:00.000', clicked), at('1:30.000', clicked), at('1:40.000', up)].join('\n'));
    const gone = waits.find((w) => w.what === 'abandoned');
    const got = waits.find((w) => w.what === 'panel');
    if (gone && gone.waited === 90000 && got && got.waited === 10000) {
      ok('a panel given up on is recorded at 90s, and the retry at 10s from its own click');
    } else bad(`retry after abandoning gave ${JSON.stringify(waits)}`);
  }
  {
    /* Two panels opened one after the other is not an abandonment, and must not be reported as one. */
    const waits = one([at('0:00.000', clicked), at('0:00.400', clicked), at('0:05.000', up)].join('\n'));
    if (!waits.some((w) => w.what === 'abandoned')) ok('two clicks in quick succession are not called an abandonment');
    else bad(`a quick second click was reported as abandoned: ${JSON.stringify(waits)}`);
  }
  {
    /* A panel that never opens at all: the ceiling is what decides it, and it leaves a record rather than silence. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat8-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    const t0 = Date.parse('2026-09-29T21:00:00Z');
    fs.writeFileSync(log, at('0:00.000', clicked) + '\n');
    const first = L.sample({ log, dir, state: {}, version: 'v1', now: t0, pid: 909, thresholdMs: 10000 });
    fs.appendFileSync(log, at('0:30.000', 'AuthManager initialized') + '\n');
    const late = L.sample({
      log, dir, state: first.state, version: 'v1', now: t0 + L.CEILING_MS + 1000, pid: 909, thresholdMs: 10000,
    });
    const gone = late.added.find((w) => w.what === 'abandoned');
    if (gone && gone.open === true && !late.state.pending.asked) {
      ok('a panel that never opens is written off at the ceiling, marked as still open');
    } else bad(`a never-opening panel gave ${JSON.stringify(late.added)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    /* A read that returns short must not turn the rest of an unsafely allocated buffer into records. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lat9-'));
    const log = path.join(root, 'Claude VSCode.log');
    const dir = path.join(root, 'rec');
    fs.writeFileSync(log, [at('0:00.000', clicked), at('0:30.000', up)].join('\n') + '\n');
    const r = L.sample({ log, dir, state: {}, version: 'v1', pid: 1010, thresholdMs: 10000 });
    const junk = L.readRecords(L.recordFile(dir, 1010)).filter((x) => x.what !== 'panel' && x.what !== 'tally');
    if (r.added.length === 1 && !junk.length) ok('nothing but real records reaches the file');
    else bad(`the file also holds ${JSON.stringify(junk)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const rows = L.summarise([
      { what: 'panel', trigger: 'click', version: 'a', waited: 1000 },
      { what: 'panel', trigger: 'click', version: 'a', waited: 3000 },
      { what: 'panel', trigger: 'click', version: 'b', waited: 90000 },
    ]);
    const worst = rows[0];
    if (rows.length === 2 && worst.version === 'b' && worst.n === 1 && rows[1].n === 2) {
      ok('versions are summarised apart, worst first, which is what shows a regression');
    } else bad(`summarise gave ${JSON.stringify(rows)}`);
  }
}

/* ── 13. one switch per addition, and each one wired at both ends ──
   A switch is three things that have to agree: a setting a person can see, a property written into the live stylesheet,
   and a place in the injected script that reads it and skips the work. Any one of them missing leaves a switch that
   looks real and does nothing - the failure this section exists to catch, since nothing else would. */
console.log('\none switch per addition, wired at both ends');
{
  const webview = require('../src/webview');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const settings = manifest.contributes.configuration.properties;
  const script = fs.readdirSync(path.join(root, 'src', 'page'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(root, 'src', 'page', f), 'utf8')).join('\n');

  const noSetting = webview.SWITCHES.filter((k) => !settings['claudeCodeExtras.show.' + k]);
  if (!noSetting.length) ok(`all ${webview.SWITCHES.length} switches have a setting a person can find`);
  else bad(`no setting for ${noSetting.join(', ')}`);

  const onByDefault = webview.SWITCHES.every((k) => settings['claudeCodeExtras.show.' + k].default === true);
  if (onByDefault) ok('every switch defaults to on, so an upgrade turns nothing off');
  else bad('a switch does not default to on');

  const unread = webview.SWITCHES.filter((k) => !script.includes(`isOff('${k}')`));
  if (!unread.length) ok('every switch is read by the injected script, so none is decoration');
  else bad(`nothing reads ${unread.join(', ')}`);

  /* Off has to be the thing that is written, so a build that never heard of a switch treats it as on. */
  const allOn = webview.liveCss({ enabled: true });
  const someOff = webview.liveCss({ enabled: true, off: ['cost', 'chime'] });
  if (!allOn.includes('--cce-off') && someOff.includes('--cce-off-cost:1')
      && someOff.includes('--cce-off-chime:1')) {
    ok('defaults write nothing, and only what is off appears in the stylesheet');
  } else bad(`all on wrote ${JSON.stringify(allOn.slice(0, 80))}`);

  /* Several windows write this one file, so the same settings have to produce the same bytes whatever order they arrive in. */
  const a = webview.liveCss({ enabled: true, off: ['chime', 'cost', 'toc'] });
  const b = webview.liveCss({ enabled: true, off: ['toc', 'chime', 'cost'] });
  if (a === b) ok('the order the switches arrive in does not change the bytes written');
  else bad('two orderings of the same switches write different stylesheets');

  /* A name that is not a switch must not become a property, or a typo in settings would write arbitrary CSS. */
  const junk = webview.liveCss({ enabled: true, off: ['cost', 'nonsense; }*{display:none'] });
  if (junk.includes('--cce-off-cost:1') && !junk.includes('nonsense')) {
    ok('a name that is not a switch is dropped rather than written into the stylesheet');
  } else bad(`an unknown switch reached the stylesheet: ${JSON.stringify(junk.slice(0, 120))}`);

  /* The rule that draws the annotation carries four switchable things, so it cannot go when one of them does. */
  const noStamps = webview.liveCss({ enabled: true, off: ['timestamps'] });
  if (noStamps.includes('::before') && noStamps.includes('--cce-off-timestamps:1')) {
    ok('switching the time off leaves the rule that also draws the duration and figures');
  } else bad('turning off timestamps dropped the rule the other three need');
}

/* ── 14. switched off, the work plan costs nothing and keeps nothing ──
   Hiding the view alone would be the worst of both: every turn still pays for the rows in front of the model and the
   reminder at the end of one, with nothing on screen to show for it. So off has to reach the plugin, and the checks here
   are one per hook, because each falls silent for its own reason and any one of them still speaking gives the cost back. */
console.log('\nswitched off, the work plan costs nothing and keeps nothing');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const session = '42000000-0000-0000-0000-000000000000';

  const stage = (enabled) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-off-'));
    fs.writeFileSync(path.join(dir, session + '.json'),
      JSON.stringify({ title: 'demo', nodes: [{ title: 'a row', state: 'todo' }] }));
    if (enabled !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ enabled }));
    /* One turn that just started, against a plan last written an hour ago - the shape the reminder asks for. */
    const now = new Date();
    const lines = [JSON.stringify({ type: 'user', timestamp: now.toISOString(), message: { content: 'go' } })];
    for (let i = 0; i < 10; i++) {
      // Write rather than Read: the reminder counts what a turn CHANGED, so a turn of reads owes the plan nothing.
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }));
    }
    const transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
    const back = (now.getTime() - 3600e3) / 1000;
    fs.utimesSync(path.join(dir, session + '.json'), back, back);
    return { dir, transcript };
  };
  const run = (script, dir, payload) => (cp.spawnSync('python3', [path.join(hooks, script), dir], {
    encoding: 'utf8', input: JSON.stringify(payload),
  }).stdout || '').trim();

  /* Two changes in one batch, which is what the reminder at the start of the work needs before it says anything. */
  const working = { session_id: session, prompt_id: 'p-switch', hook_event_name: 'PostToolBatch',
    tool_calls: [{ tool_name: 'Edit', tool_input: {} }, { tool_name: 'Write', tool_input: {} }] };
  for (const [what, enabled] of [['on by default', undefined], ['on', true]]) {
    const t = stage(enabled);
    const injected = run('inject-work-plan.py', t.dir,
      { session_id: session, prompt_id: 'p-switch', hook_event_name: 'UserPromptSubmit' });
    const nudged = run('nudge-work-plan.py', t.dir,
      { session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' });
    const reminded = run('remind-work-plan.py', t.dir, working);
    if (injected.includes('a row') && nudged.includes('neither read nor updated') && reminded.includes('no row of the work plan is `doing`')) {
      ok(`${what}: the rows arrive, and both reminders speak`);
    } else bad(`${what}: injected ${injected.length} bytes, nudge ${nudged.length} bytes, start-of-work ${reminded.length} bytes`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(false);
    const injected = run('inject-work-plan.py', t.dir,
      { session_id: session, prompt_id: 'p-switch', hook_event_name: 'UserPromptSubmit' });
    if (!injected) ok('off: nothing is put in front of the model, which is where the tokens went');
    else bad(`off: still injected ${injected.length} bytes`);

    const nudged = run('nudge-work-plan.py', t.dir,
      { session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' });
    if (!nudged) ok('off: the end of a turn says nothing');
    else bad(`off: still nudged ${JSON.stringify(nudged.slice(0, 80))}`);

    /* Off leaves no mark of the turn, and the reminder at the start of the work is silent even where a mark is left over
       from before the switch, since it checks for itself. */
    const left = fs.existsSync(path.join(t.dir, session + '.turn'));
    fs.writeFileSync(path.join(t.dir, session + '.turn'),
      JSON.stringify({ prompt: 'p-switch', began: Date.now() / 1000, changes: 5, reminded: false }));
    const reminded = run('remind-work-plan.py', t.dir, working);
    if (!left && !reminded) ok('off: no mark of the turn is left, and the start of the work says nothing');
    else bad(`off: mark left ${left}, start-of-work said ${JSON.stringify(reminded.slice(0, 80))}`);

    /* The description of the skill stays in context while the plugin is loaded, so an agent can decide to keep a plan on
       its own. This is the only thing left that can stop one being kept where nobody can see it. */
    const denied = run('guard-work-plan.py', t.dir, {
      tool_name: 'Write', hook_event_name: 'PreToolUse',
      tool_input: { file_path: path.join(t.dir, session + '.json'), content: '{}' },
    });
    let decision = '';
    try { decision = JSON.parse(denied).hookSpecificOutput.permissionDecision; } catch (_) {}
    if (decision === 'deny' && denied.includes('switched off')) ok('off: a write to a plan is refused, and says why');
    else bad(`off: the guard said ${JSON.stringify(denied.slice(0, 80))}`);

    /* A write somewhere else is none of this plugin's business, switched off or on. */
    const other = run('guard-work-plan.py', t.dir, {
      tool_name: 'Write', hook_event_name: 'PreToolUse',
      tool_input: { file_path: path.join(t.dir, 'notes.txt'), content: 'hello' },
    });
    if (!other) ok('off: a write to anything else is left alone');
    else bad(`off: the guard interfered with an unrelated write: ${JSON.stringify(other.slice(0, 80))}`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    /* The setting has to reach the plugin, and the view has to be hidden by it. Neither is visible from the other side. */
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const view = manifest.contributes.views.claudeCodeExtras[0];
    const setting = manifest.contributes.configuration.properties['claudeCodeExtras.workPlan'];
    if (setting && setting.default === true && view.when === 'config.claudeCodeExtras.workPlan') {
      ok('the view is hidden by the same setting the hooks read, and starts on');
    } else bad(`setting ${JSON.stringify(setting && setting.default)}, view when ${JSON.stringify(view.when)}`);
  }
}

/* ── 15. whose plan the tree shows ──
   The view's one claim is that it shows what THIS conversation has to do, and the answer to "which conversation" has three
   values, not two: a name, "none is open", and "nothing has said yet". Flattening the last two is what drew every
   conversation on the machine as soon as the last panel closed - other people's leftovers, in a view that promised one
   thing. Nothing else here loads this module, since it needs the editor's own API; a stub covers the little it uses. */
console.log('\nwhose plan the tree shows');
{
  const Module = require('module');
  const realResolve = Module._resolveFilename;
  const stub = path.join(os.tmpdir(), 'cce-vscode-stub.js');
  fs.writeFileSync(stub, `
    class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
    module.exports = {
      TreeItem,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      MarkdownString: class { constructor(v) { this.value = v; } },
      Uri: { file: (p) => ({ fsPath: p }) },
      EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    };
  `);
  Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? stub : realResolve.call(this, request, ...rest);
  };
  let view;
  try {
    ({ WorkPlanProvider: view } = require('../src/workplan-view'));
  } finally {
    Module._resolveFilename = realResolve;
  }

  /* The rule is one line: show the conversation in front of the reader, or nothing. There is no state that shows every
     conversation - a fresh window that has never been told which one it is looking at shows an empty tree, not the whole
     machine. */
  const p = new view();
  if (p.setFocus('abc') === true && p.focus === 'abc') ok('a named conversation is recorded');
  else bad(`setFocus('abc') left ${JSON.stringify(p.focus)}`);

  if (p.setFocus('abc') === false) ok('the same conversation twice is not announced as a change');
  else bad('an unchanged focus reported a move');

  /* Focus but no file. A conversation with no plan yet reads as empty, not as a reason to fall back to everyone else's -
     the bug this section was rewritten for: a fresh project showed other projects' plans. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-focus-'));
  const plan = require('../src/workplan');
  const seen = plan.readPlan.length; // arity guard: readPlan(session) still takes the id
  if (seen === 1) ok('a focused conversation is read by id alone');
  else bad(`readPlan takes ${seen} args, expected 1`);

  /* No path that shows all plans is left in the view: readPlans is gone, and the fallback is the empty list. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workplan-view.js'), 'utf8');
  if (/this\.focus \? readPlan\(this\.focus\) : \[\]/.test(src) && !/readPlans/.test(src)) {
    ok('with no conversation in focus the tree is empty, never every conversation on the machine');
  } else bad('the view can still fall back to showing all plans');
  if (!/readPlans/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'workplan.js'), 'utf8'))) {
    ok('the show-everything function is gone, not just unreferenced');
  } else bad('readPlans is still defined in workplan.js');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stub, { force: true });
}

/* ── 16. one list of states, in three places ──
   The view draws a state, the plugin's scripts write and read it, and the skill tells the model what each one means.
   The three cannot import from each other - JavaScript, Python and prose - so this is what holds them together. A state
   one of them does not know is drawn as `todo`, refused by the row command, or never explained, and none of those says
   anything when it happens. */
console.log('\none list of states, in three places');
{
  const root = path.join(__dirname, '..');
  const plan = require('../src/workplan');
  const py = fs.readFileSync(path.join(root, 'claude-plugin', 'agent-work-plan', 'hooks', 'plan_path.py'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'claude-plugin', 'agent-work-plan', 'skills', 'maintain', 'SKILL.md'), 'utf8');
  const tuple = /^STATES = \(([^)]*)\)/m.exec(py);
  const inPython = tuple ? (tuple[1].match(/"([a-z]+)"/g) || []).map((s) => s.slice(1, -1)) : [];
  const inSkill = [];
  for (const line of skill.split('\n')) {
    const m = /^\| `([a-z]+)` \|/.exec(line);
    // The table's own header is `state`, written the same way as the rows under it.
    if (m && m[1] !== 'state' && !inSkill.includes(m[1])) inSkill.push(m[1]);
  }
  const want = plan.STATES.join();
  if (inPython.join() === want) ok(`the plugin's scripts and the view list the same ${plan.STATES.length} states, in one order`);
  else bad(`the view lists ${want}, plan_path.py ${inPython.join()}`);
  if (inSkill.slice().sort().join() === plan.STATES.slice().sort().join()) ok('the skill explains every one of them, and no other');
  else bad(`the skill's table has ${inSkill.join()}, the view ${want}`);
}

/* ── 17. what the injected block says about the work in hand ──
   The block is the one thing said before the work rather than after it, so what it says about `doing` is checked here
   word for word: whether anything is `doing` changes the sentence, how long a row has been `doing` or `waiting` is on the
   row, and the command that changes a row is given with a path that exists. */
console.log('\nwhat the injected block says about the work in hand');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const session = '43000000-0000-0000-0000-000000000000';
  const inject = (nodes, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-inj-'));
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [path.join(hooks, 'inject-work-plan.py'), dir], {
      encoding: 'utf8',
      input: JSON.stringify(Object.assign({ session_id: session, hook_event_name: 'UserPromptSubmit' }, extra)),
    });
    let text = '', mark = null;
    try { text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) {}
    try { mark = JSON.parse(fs.readFileSync(path.join(dir, session + '.turn'), 'utf8')); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
    return { text, mark };
  };
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const rowOf = (text, title) => text.split('\n').find((l) => l.includes('. ' + title + '   [')) || '';

  {
    const idle = inject([{ title: 'a', state: 'todo' }]).text;
    const busy = inject([{ title: 'a', state: 'doing' }]).text;
    if (idle.includes('Nothing is `doing` right now.') && !idle.includes('earlier turn')) ok('with nothing doing, it says so');
    else bad(`with nothing doing it said ${JSON.stringify(idle.slice(0, 200))}`);
    if (busy.includes('left that way by an earlier turn') && !busy.includes('Nothing is `doing`')) {
      ok('with a row doing, it says that row was left by an earlier turn');
    } else bad(`with a row doing it said ${JSON.stringify(busy.slice(0, 200))}`);
  }
  {
    const text = inject([
      { title: 'working', state: 'doing', since: ago(2 * 3600 + 60) },
      { title: 'held', state: 'waiting', since: ago(3 * 86400 + 60), note: 'on the user' },
      { title: 'untimed', state: 'doing' },
      { title: 'queued', state: 'todo', since: ago(5 * 3600) },
      { title: 'colonless', state: 'doing', since: ago(5 * 3600 + 60).replace(/\.\d+Z$/, '+0000') },
    ]).text;
    const got = ['working', 'held', 'untimed', 'queued', 'colonless'].map((t) => rowOf(text, t).replace(/^.*\[/, '['));
    const want = ['[doing for 2h]', '[waiting for 3d · on the user]', '[doing]', '[todo]', '[doing for 5h]'];
    if (got.join('|') === want.join('|')) ok('a row doing or waiting says for how long, whichever way its time is written');
    else bad(`the rows came out ${JSON.stringify(got)}`);
  }
  {
    const text = inject([{ title: 'a', state: 'todo' }]).text;
    const m = /To change a row: python3 (\S+) (\S+) set <row> <state>/.exec(text);
    if (m && fs.existsSync(m[1]) && path.basename(m[1]) === 'plan-row.py' && m[2].endsWith(session + '.json')) {
      ok('the command that changes a row is given with a path that exists, against this plan');
    } else bad(`the command line is ${JSON.stringify(m && m[0])}`);
  }
  {
    const before = Date.now() / 1000;
    const marked = inject([{ title: 'a', state: 'todo' }], { prompt_id: 'p-17' }).mark;
    const unnamed = inject([{ title: 'a', state: 'todo' }]).mark;
    const allClosed = inject([{ title: 'a', state: 'done' }], { prompt_id: 'p-17b' });
    if (marked && marked.prompt === 'p-17' && marked.began >= before - 1 && marked.reminded === false && marked.changes === 0) {
      ok('a turn leaves a mark naming its prompt and when it began');
    } else bad(`the mark was ${JSON.stringify(marked)}`);
    if (!unnamed) ok('a turn without a prompt id leaves no mark, since nothing could match it');
    else bad(`a turn with no prompt id left ${JSON.stringify(unnamed)}`);
    /* Nothing open means nothing to inject - and new work started in that turn is exactly what the mark is for. */
    if (!allClosed.text && allClosed.mark && allClosed.mark.prompt === 'p-17b') ok('a plan with nothing open injects nothing, and still marks the turn');
    else bad(`with nothing open: injected ${allClosed.text.length} bytes, mark ${JSON.stringify(allClosed.mark)}`);
  }
}

/* ── 18. the reminder when a turn starts working ──
   It speaks at most once a turn and only when it is owed, and most of what is tested here is the silence: a reminder
   that fires where nothing was owed teaches the reader to skip it, which costs the one time it is needed. */
console.log('\nthe reminder when a turn starts working');
{
  const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
  const session = '44000000-0000-0000-0000-000000000000';
  const stage = (nodes, limits) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-remind-'));
    const plan = path.join(dir, session + '.json');
    fs.writeFileSync(plan, JSON.stringify({ nodes }));
    const back = Date.now() / 1000 - 3600;
    fs.utimesSync(plan, back, back);
    if (limits) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(limits));
    return { dir, plan };
  };
  const begin = (t, prompt) => cp.spawnSync('python3', [path.join(hooks, 'inject-work-plan.py'), t.dir], {
    encoding: 'utf8', input: JSON.stringify({ session_id: session, prompt_id: prompt, hook_event_name: 'UserPromptSubmit' }),
  });
  const batch = (t, prompt, calls, extra = {}) => (cp.spawnSync('python3', [path.join(hooks, 'remind-work-plan.py'), t.dir], {
    encoding: 'utf8',
    input: JSON.stringify(Object.assign({ session_id: session, prompt_id: prompt, hook_event_name: 'PostToolBatch',
      tool_calls: calls }, extra)),
  }).stdout || '').trim();
  const spoke = (s) => s.includes('no row of the work plan is `doing`');
  const E = { tool_name: 'Edit', tool_input: { file_path: '/elsewhere/a.js' } };
  const R = { tool_name: 'Read', tool_input: { file_path: '/elsewhere/a.js' } };
  const todo = [{ title: 'a', state: 'todo' }];
  const done = (t) => fs.rmSync(t.dir, { recursive: true, force: true });

  {
    const t = stage(todo);
    begin(t, 'p1');
    const said = [batch(t, 'p1', [R]), batch(t, 'p1', [E]), batch(t, 'p1', [E]), batch(t, 'p1', [E])].map(spoke);
    if (said.join() === 'false,false,true,false') ok('silent through reading and one change, speaks at the second, and only once');
    else bad(`reading, then three changes, spoke ${JSON.stringify(said)}`);
    begin(t, 'p2');
    if (spoke(batch(t, 'p2', [E, E]))) ok('the next turn can be told again, and two changes in one batch are enough');
    else bad('a new turn with two changes in one batch said nothing');
    done(t);
  }
  {
    /* A sub-agent shares the session id, and its work is recorded by the thread that sent it. Its calls must not count
       towards the main thread's turn either, or the main thread would be told on its first change of its own. */
    const t = stage(todo);
    begin(t, 'p1');
    const sub = batch(t, 'p1', [E, E], { agent_id: 'agent-1' });
    const main = batch(t, 'p1', [E]);
    if (!sub && !main) ok('a sub-agent is not told, and what it changed does not count towards the turn');
    else bad(`sub-agent said ${JSON.stringify(sub.slice(0, 60))}, main thread after it ${JSON.stringify(main.slice(0, 60))}`);
    done(t);
  }
  {
    const t = stage(todo);
    begin(t, 'p1');
    if (!batch(t, 'p0', [E, E])) ok('a batch from a turn that left no mark says nothing');
    else bad('a batch whose prompt id matches no mark was spoken to');
    done(t);
  }
  {
    /* A turn that has already been to the plan has settled it, whatever it wrote there. */
    const t = stage(todo);
    begin(t, 'p1');
    const now = Date.now() / 1000 + 1;
    fs.utimesSync(t.plan, now, now);
    if (!batch(t, 'p1', [E, E])) ok('a turn that has written to the plan is left alone');
    else bad('a turn that had written to the plan was still told');
    done(t);
  }
  {
    const t = stage([{ title: 'a', state: 'todo', children: [{ title: 'b', state: 'doing' }] }]);
    begin(t, 'p1');
    if (!batch(t, 'p1', [E, E])) ok('a row doing anywhere in the tree is enough to say nothing');
    else bad('a plan with a nested doing row was still told');
    done(t);
  }
  {
    /* Keeping the plan is not the work the plan is about. */
    const t = stage(todo);
    begin(t, 'p1');
    const keep = { tool_name: 'Bash', tool_input: { command: `python3 fix.py > ${t.plan}` } };
    const kept = batch(t, 'p1', [keep, keep]);
    const after = batch(t, 'p1', [E]);
    if (!kept && !after) ok('calls that only keep the plan neither count nor speak');
    else bad(`keeping the plan said ${JSON.stringify(kept.slice(0, 60))}, one change after it ${JSON.stringify(after.slice(0, 60))}`);
    done(t);
  }
  {
    const t = stage(todo, { nudgeMinChanges: 1 });
    begin(t, 'p1');
    if (spoke(batch(t, 'p1', [E]))) ok('how many changes it waits for is read from the settings file');
    else bad('with the threshold at one, the first change said nothing');
    done(t);
  }
  {
    const t = stage(todo);
    begin(t, 'p1');
    let said = '';
    try { said = JSON.parse(batch(t, 'p1', [E, E])).hookSpecificOutput.additionalContext; } catch (_) {}
    const m = /\n {2}python3 (\S+) (\S+) set <row> doing\n/.exec(said);
    if (m && fs.existsSync(m[1]) && m[2] === t.plan) ok('what it says names the row command with its full path');
    else bad(`it said ${JSON.stringify(said.slice(0, 300))}`);
    done(t);
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-remind-'));
    if (!batch({ dir }, 'p1', [E, E])) ok('a conversation with no plan is not told anything');
    else bad('a conversation with no plan was told to mark a row');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 19. the row command ──
   The one script here that writes a plan, so what it must leave alone matters as much as what it changes: every other
   row, every other field, and a correction the user made by hand a moment ago. */
console.log('\nthe row command');
{
  const tool = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks', 'plan-row.py');
  const session = '45000000-0000-0000-0000-000000000000';
  const stage = (body, name = session + '.json') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-row-'));
    const file = path.join(dir, name);
    if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return { dir, file };
  };
  const row = (t, ...args) => cp.spawnSync('python3', [tool, t.file, ...args], { encoding: 'utf8' });
  const read = (t) => JSON.parse(fs.readFileSync(t.file, 'utf8'));
  const recent = (stamp) => typeof stamp === 'string' && Math.abs(Date.parse(stamp) - Date.now()) < 120000;
  const plan = () => ({
    title: 'demo',
    nodes: [
      { title: 'one', state: 'todo', detail: 'kept as it is', opened: '2026-01-01T00:00:00+00:00' },
      { title: 'two', state: 'todo', handEdited: true, children: [{ title: 'two-a', state: 'todo', note: 'n' }] },
    ],
  });
  const done = (t) => fs.rmSync(t.dir, { recursive: true, force: true });

  {
    const t = stage(plan());
    const r = row(t, 'set', '2.1', 'doing');
    const d = read(t);
    const kid = d.nodes[1].children[0];
    const rest = JSON.stringify([d.title, d.nodes[0], d.nodes[1].handEdited, d.nodes[1].title, kid.note]);
    if (r.status === 0 && r.stdout.trim() === 'row 2.1: todo -> doing' && kid.state === 'doing' && recent(kid.since)) {
      ok('a row is set by its number, with the time it entered the state');
    } else bad(`set 2.1 doing: status ${r.status}, said ${JSON.stringify(r.stdout + r.stderr)}, row ${JSON.stringify(kid)}`);
    if (rest === JSON.stringify(['demo', plan().nodes[0], true, 'two', 'n'])) ok('and every other row and field is left as it was');
    else bad(`other content moved: ${rest}`);
    done(t);
  }
  {
    const t = stage(plan());
    row(t, 'set', '1', 'done');
    const closed = read(t).nodes[0];
    row(t, 'set', '1', 'todo');
    const reopened = read(t).nodes[0];
    if (closed.closed && closed.closed === closed.since && !('closed' in reopened) && reopened.opened === '2026-01-01T00:00:00+00:00') {
      ok('closing a row stamps when, and reopening it takes the stamp away again');
    } else bad(`closed ${JSON.stringify(closed)}, reopened ${JSON.stringify(reopened)}`);
    done(t);
  }
  {
    const t = stage(plan());
    row(t, 'set', '1', 'waiting', '--note', 'on the user');
    const noted = read(t).nodes[0].note;
    row(t, 'set', '1', 'doing', '--note', '');
    const cleared = read(t).nodes[0];
    if (noted === 'on the user' && !('note' in cleared)) ok('a note is set with the state, and an empty one removes it');
    else bad(`note was ${JSON.stringify(noted)}, then ${JSON.stringify(cleared.note)}`);
    done(t);
  }
  {
    const t = stage(plan());
    const top = row(t, 'add', 'doing', '修一下标题');
    const under = row(t, 'add', 'todo', 'two-b', '--under', '2');
    const d = read(t);
    const added = d.nodes[2];
    if (top.stdout.trim() === 'row 3 added: doing' && added.title === '修一下标题' && added.state === 'doing'
      && recent(added.opened) && added.opened === added.since && Array.isArray(added.children)
      && under.stdout.trim() === 'row 2.2 added: todo' && d.nodes[1].children[1].title === 'two-b') {
      ok('a row is added at the end or under another, and says the number it got');
    } else bad(`added ${JSON.stringify(top.stdout + top.stderr)} and ${JSON.stringify(under.stdout + under.stderr)}`);
    if (fs.readFileSync(t.file, 'utf8').includes('修一下标题')) ok('a title in the conversation\'s own language is written as it is, not escaped');
    else bad('a non-ASCII title was written as escapes');
    done(t);
  }
  {
    const t = stage(undefined);
    const r = row(t, 'add', 'doing', 'first');
    if (r.status === 0 && read(t).nodes.length === 1) ok('adding a row to a plan that does not exist yet starts one');
    else bad(`adding to no plan: status ${r.status}, ${JSON.stringify(r.stderr)}`);
    done(t);
  }
  {
    /* Every refusal leaves the file exactly as it was. */
    const refusals = [
      ['a row that is not there', () => stage(plan()), (t) => row(t, 'set', '9', 'doing'), 1],
      ['a state that is not one of the seven', () => stage(plan()), (t) => row(t, 'set', '1', 'started'), 2],
      ['a file that does not parse', () => stage('{"nodes": [}'), (t) => row(t, 'set', '1', 'doing'), 1],
      ['a file that is not a plan', () => stage(plan(), 'notes.json'), (t) => row(t, 'set', '1', 'doing'), 1],
      ['plans switched off', () => {
        const t = stage(plan());
        fs.writeFileSync(path.join(t.dir, 'config.json'), '{"enabled": false}');
        return t;
      }, (t) => row(t, 'set', '1', 'doing'), 1],
    ];
    for (const [what, make, act, code] of refusals) {
      const t = make();
      const before = fs.readFileSync(t.file, 'utf8');
      const r = act(t);
      const after = fs.readFileSync(t.file, 'utf8');
      const strays = fs.readdirSync(t.dir).filter((n) => n.endsWith('.tmp'));
      if (r.status === code && before === after && !strays.length) ok(`refused, and nothing touched: ${what}`);
      else bad(`${what}: status ${r.status}, file changed ${before !== after}, left ${JSON.stringify(strays)}`);
      done(t);
    }
    const t = stage(undefined);
    const r = row(t, 'set', '1', 'doing');
    if (r.status === 1 && !fs.existsSync(t.file)) ok('setting a row in a plan that does not exist creates nothing');
    else bad(`set on no plan: status ${r.status}, file made ${fs.existsSync(t.file)}`);
    done(t);
  }
}

/* ── 20. how a row being worked on, or waiting, is drawn ──
   Uses the same stub of the editor's API as section 15, made again here since that section removes it. */
console.log('\nhow a row being worked on, or waiting, is drawn');
{
  const Module = require('module');
  const realResolve = Module._resolveFilename;
  const stub = path.join(os.tmpdir(), 'cce-vscode-stub-20.js');
  fs.writeFileSync(stub, `
    class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
    module.exports = {
      TreeItem,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      MarkdownString: class { constructor(v) { this.value = v; } },
      Uri: { file: (p) => ({ fsPath: p }) },
      EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    };
  `);
  Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? stub : realResolve.call(this, request, ...rest);
  };
  let viewMod;
  try {
    delete require.cache[require.resolve('../src/workplan-view')];
    viewMod = require('../src/workplan-view');
  } finally {
    Module._resolveFilename = realResolve;
  }
  const plan = require('../src/workplan');

  {
    const icons = plan.STATES.map((s) => viewMod.LOOK[s] && viewMod.LOOK[s].icon);
    const w = viewMod.LOOK.waiting, talk = viewMod.LOOK.discussing;
    if (icons.every(Boolean) && new Set(icons).size === icons.length && w && w.color === 'charts.orange' && w.color !== talk.color) {
      ok('every state has its own shape, and waiting is orange, apart from discussing in colour as well');
    } else bad(`icons per state: ${JSON.stringify(icons)}, waiting colour ${w && w.color}`);
    const pick = (v) => viewMod.waitingIcon(v);
    const want = [['1.140.0', 'clockface'], ['1.111.0', 'clockface'], ['2.0.0', 'clockface'], ['1.140.0-insider', 'clockface'],
      ['1.110.0', 'watch'], ['1.94.0', 'watch'], [undefined, 'watch'], ['', 'watch'], ['x.y', 'watch']];
    const wrong = want.filter(([v, icon]) => pick(v) !== icon);
    if (!wrong.length) ok('a clock face from VS Code 1.111, where the icon font has one, and the watch before it or when unknown');
    else bad(`waitingIcon gave ${wrong.map(([v]) => `${v}: ${pick(v)}`).join(', ')}`);
  }
  {
    const now = Date.now();
    const at = (s, state = 'doing') => viewMod.held({ state, since: now - s * 1000 }, now);
    const got = [at(30), at(61 * 60), at(49 * 3600), at(3600, 'todo'), viewMod.held({ state: 'doing', since: 0 }, now),
      at(-600)];
    if (got.join() === '1m,1h,2d,,,') ok('how long, in minutes, hours or days, and nothing where it does not apply');
    else bad(`held() gave ${JSON.stringify(got)}`);
  }
  {
    /* The tree and the model read the same figure for the same row, which needs the two to step at the same places. */
    const hooks = path.join(__dirname, '..', 'claude-plugin', 'agent-work-plan', 'hooks');
    const session = '46000000-0000-0000-0000-000000000000';
    const spans = [30, 59 * 60 + 30, 61 * 60, 47 * 3600 + 60, 49 * 3600, 10 * 86400];
    const now = Date.now();
    const nodes = spans.map((s, i) => ({ title: 'r' + i, state: 'doing', since: new Date(now - s * 1000).toISOString() }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-age-'));
    fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ nodes }));
    const r = cp.spawnSync('python3', [path.join(hooks, 'inject-work-plan.py'), dir], {
      encoding: 'utf8', input: JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit' }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    let text = '';
    try { text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) {}
    const py = spans.map((_, i) => ((new RegExp('\\. r' + i + ' {3}\\[doing for (\\w+)\\]').exec(text)) || [])[1]);
    const js = nodes.map((n) => viewMod.held({ state: 'doing', since: Date.parse(n.since) }, now));
    if (py.join() === js.join()) ok(`the tree and the injected block give the same figure: ${js.join(' ')}`);
    else bad(`the injected block says ${py.join()}, the tree ${js.join()}`);
  }
  {
    const p = new viewMod.WorkPlanProvider();
    const element = (node) => ({ kind: 'node', node, plan: { session: 's', file: '/f' }, path: [], key: 'k', num: '3' });
    const now = Date.now();
    const busy = p.getTreeItem(element({ title: 't', state: 'doing', note: '', detail: '', opened: now - 7200e3,
      since: now - 7200e3 - 60e3, closed: 0, children: [] }));
    const over = p.getTreeItem(element({ title: 't', state: 'done', note: '', detail: '', opened: now - 7200e3,
      since: now - 60e3, closed: now - 60e3, children: [] }));
    if (/ · for 2h$/.test(busy.description) && busy.tooltip.value.includes('doing for 2h')
      && busy.command.arguments[0].state === 'doing for 2h' && !/for /.test(over.description)) {
      ok('a row doing says for how long on the row, in the hover and in the dialog; a closed row does not');
    } else bad(`doing row: ${JSON.stringify(busy.description)}; done row: ${JSON.stringify(over.description)}`);
  }
  {
    /* The figure goes stale with nothing in the file changing, so it has to be part of what decides a redraw. */
    const now = Date.now();
    const nodes = [{ state: 'todo', children: [{ state: 'waiting', since: now - 30e3, children: [] }] }];
    if (viewMod.heldAll(nodes, now).join() !== viewMod.heldAll(nodes, now + 3 * 3600e3).join()) {
      ok('the time a row has waited changes what the tree compares, so it is redrawn as the time passes');
    } else bad('the figure is the same an hour later, so the tree would never redraw it');
  }
  fs.rmSync(stub, { force: true });
}

/* ── 21. an uninstall puts Claude Code back at once ──
   The editor runs the uninstall hook only when it deletes this extension's folder, which in remote development once
   came eight hours after the uninstall. deactivate runs at the restart that follows an uninstall - and at every reload
   and every window closing too, so what decides everything is the test for "this copy is being uninstalled". Most of
   the cases below are the ones that must not count as one. */
console.log('\nan uninstall puts Claude Code back at once');
{
  const removal = require('../src/removal');
  const ID = 'xnervwang.claude-code-extras';
  const me = ID + '-1.0.5';
  const stage = (folders, marked, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-uninst-'));
    for (const f of folders) fs.mkdirSync(path.join(dir, f));
    if (body !== undefined) fs.writeFileSync(path.join(dir, '.obsolete'), body);
    else if (marked) fs.writeFileSync(path.join(dir, '.obsolete'), JSON.stringify(Object.fromEntries(marked.map((m) => [m, true]))));
    return dir;
  };
  const cases = [
    ['this copy marked for deletion and nothing else left: an uninstall', [me], [me], true],
    ['this copy marked while a newer version is not: an update, not an uninstall', [me, ID + '-1.0.6'], [me], false],
    ['this copy not marked: an ordinary reload or a window closing', [me], [], false],
    ['every version marked: an uninstall', [me, ID + '-1.0.4'], [me, ID + '-1.0.4'], true],
    ['an extension whose name merely starts with ours is not a version of it', [me, ID + '-helper-1.0.0'], [me], true],
  ];
  for (const [what, folders, marked, want] of cases) {
    const dir = stage(folders, marked);
    const got = removal.beingUninstalled(path.join(dir, me), ID);
    if (got === want) ok(what);
    else bad(`${what}: said ${got}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const none = stage([me]);
    const junk = stage([me], null, '{not json');
    if (!removal.beingUninstalled(path.join(none, me), ID) && !removal.beingUninstalled(path.join(junk, me), ID)) {
      ok('no record at all, or one that does not parse, is never read as an uninstall');
    } else bad('a missing or broken .obsolete was read as an uninstall');
    fs.rmSync(none, { recursive: true, force: true });
    fs.rmSync(junk, { recursive: true, force: true });
  }

  /* The restore itself, on a copy of a real Claude Code install: patched by the same code that patches it in use, then
     put back by the code deactivate calls. Only the files we patch are copied. */
  const source = (() => {
    for (const d of Array.from(new Set(extensionsDirs()))) {
      for (const install of webview.findInstalls(d)) {
        const files = ADAPTERS.map((a) => pristine(a.targetFile(install), a));
        if (files.every((f) => f && !f.foreign)) return { install, files };
      }
    }
    return null;
  })();
  if (!source) note('no pristine Claude Code install here to try a restore on');
  else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-restore-'));
    const copy = path.join(root, 'anthropic.claude-code-9.9.9-linux-x64');
    ADAPTERS.forEach((a, i) => {
      const f = a.targetFile(copy);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, source.files[i].src);
    });
    const applied = ADAPTERS.map((a) => a.apply(copy, { enabled: true }));
    const patched = ADAPTERS.every((a) => a.status(copy) === 'patched');
    const done = removal.restoreAll([root]);
    const same = ADAPTERS.every((a, i) => fs.readFileSync(a.targetFile(copy), 'utf8') === source.files[i].src);
    const left = [];
    for (const a of ADAPTERS) {
      const b = a.targetFile(copy) + a.BACKUP_SUFFIX;
      if (fs.existsSync(b)) left.push(path.basename(b));
    }
    for (const n of fs.readdirSync(path.join(copy, 'webview'))) if (n.startsWith('claude-code-extras')) left.push(n);
    if (patched && done.filter((r) => r.changed).length === ADAPTERS.length && same && !left.length) {
      ok(`a patched copy of ${path.basename(source.install)} comes back byte for byte, with no backup or stylesheet left`);
    } else {
      bad(`patched ${patched}, restored ${JSON.stringify(done.map((r) => r.message))}, identical ${same}, `
        + `left ${JSON.stringify(left)}, applied ${JSON.stringify(applied.map((r) => r.message))}`);
    }
    const again = removal.restoreAll([root]);
    if (again.every((r) => !r.changed)) ok('a second restore changes nothing, so the editor running the hook later is harmless');
    else bad(`a second restore changed something: ${JSON.stringify(again)}`);
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* The rest goes to a process that outlives the host: the same uninstall.js, run as plain Node, detached. */
  {
    const calls = [];
    const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.push('unref'); } }; };
    const where = path.join(os.tmpdir(), me);
    removal.finishLater(where, fake);
    const c = calls[0] || {};
    if (c.cmd === process.execPath && c.args && c.args[0] === path.join(where, 'uninstall.js') && c.opts.detached === true
      && c.opts.stdio === 'ignore' && c.opts.env.ELECTRON_RUN_AS_NODE === '1' && calls[1] === 'unref') {
      ok('the plugin is unregistered by uninstall.js in a detached process, run as plain Node');
    } else bad(`finishLater spawned ${JSON.stringify(calls)}`);
  }

  /* The wiring, read from the source, since it is what makes any of the above happen in the editor. */
  {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    const un = fs.readFileSync(path.join(__dirname, '..', 'uninstall.js'), 'utf8');
    const deact = (/function deactivate\(\) \{([\s\S]*?)\n\}/.exec(ext) || [])[1] || '';
    const checks = [
      ['deactivate restores and hands the rest on, and only for an uninstall',
        /beingUninstalled\(selfPath, ID\)/.test(deact) && /restoreAll/.test(deact) && /finishLater/.test(deact)],
      ['a window that has not restarted yet restores rather than patching again', /if \(removed\(\) \|\| leaving\)/.test(ext)],
      ['and writes no stylesheet back',
        /const writeLiveNow = \(\) => \{\s*if \(uninstalling\(\)( \|\| replaced\(\))?\) return;/.test(ext)
        && /if \(removed\(\) \|\| !enabled\(\) \|\| uninstalling\(\)( \|\| replaced\(\))?\) return;/.test(ext)],
      ['the uninstall hook restores through the same code', /removal\.restoreAll\(removal\.roots\(/.test(un) && !/adapter\.restore\(/.test(un)],
    ];
    for (const [what, pass] of checks) {
      if (pass) ok(what);
      else bad(what);
    }
  }
}

/* ── 22. the work plan plugin after an uninstall and a reinstall ──
   The memory of having registered the plugin is kept by the editor and outlives an uninstall of this extension, which
   unregisters the plugin; a reinstall then read "registered" and never registered it again. The cases that must NOT
   bring it back matter as much: removing the plugin on purpose leaves its marketplace known, and that has to stick. */
console.log('\nthe work plan plugin after an uninstall and a reinstall');
{
  const pi = require('../src/plugin-install');
  const home = (plugins, markets) => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-reg-'));
    fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true });
    if (plugins !== undefined) fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), plugins);
    if (markets !== undefined) fs.writeFileSync(path.join(h, '.claude', 'plugins', 'known_marketplaces.json'), markets);
    return h;
  };
  const listed = JSON.stringify({ version: 2, plugins: { [pi.REF]: [{ scope: 'user' }] } });
  const none = JSON.stringify({ version: 2, plugins: { 'other@elsewhere': [] } });
  const market = JSON.stringify({ [pi.MARKETPLACE]: { source: { source: 'directory' } } });
  const noMarket = JSON.stringify({ elsewhere: {} });
  const cases = [
    ['plugin and marketplace both gone, as an uninstall of this extension leaves them: register again', none, noMarket, true],
    ['the plugin gone while its marketplace is still known, as removing it on purpose leaves it: leave it', none, market, false],
    ['the plugin still listed: nothing to do', listed, market, false],
    ['records that cannot be read: do nothing', '{oops', noMarket, false],
    ['no records at all: do nothing', undefined, undefined, false],
  ];
  for (const [what, plugins, markets, want] of cases) {
    const h = home(plugins, markets);
    const got = pi.registrationGone(h);
    if (got === want) ok(what);
    else bad(`${what}: said ${got}`);
    fs.rmSync(h, { recursive: true, force: true });
  }
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const body = (/const syncPlugin = async \(retry\) => \{([\s\S]*?)\n  \};/.exec(ext) || [])[1] || '';
  if (/registrationGone\(\)/.test(body) && /!undone/.test(body) && /&& staged\) return;/.test(body)) {
    ok('registering consults Claude Code\'s records and the staged copy, not only its own memory');
  } else bad('syncPlugin still trusts only its remembered state');
}

/* ── 23. every call on the work plan view is one it has ──
   extension.js holds the view in a variable named like the module it reads plans with, and once called a module
   function on the view instead: the daily sweep of abandoned plans threw "is not a function" every time it ran, and
   nothing showed it but one line in the output channel. Uses the same stub of the editor's API as sections 15 and 20. */
console.log('\nevery call on the work plan view is one it has');
{
  const Module = require('module');
  const realResolve = Module._resolveFilename;
  const stub = path.join(os.tmpdir(), 'cce-vscode-stub-23.js');
  fs.writeFileSync(stub, `
    class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
    module.exports = {
      TreeItem,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      MarkdownString: class { constructor(v) { this.value = v; } },
      Uri: { file: (p) => ({ fsPath: p }) },
      EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    };
  `);
  Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? stub : realResolve.call(this, request, ...rest);
  };
  let Provider;
  try {
    delete require.cache[require.resolve('../src/workplan-view')];
    ({ WorkPlanProvider: Provider } = require('../src/workplan-view'));
  } finally {
    Module._resolveFilename = realResolve;
  }
  const view = new Provider();
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const called = Array.from(new Set((ext.match(/\bworkplan\.(\w+)\(/g) || []).map((m) => m.slice(9, -1))));
  const missing = called.filter((name) => typeof view[name] !== 'function');
  if (called.length && !missing.length) ok(`all ${called.length} methods extension.js calls on the view exist: ${called.join(', ')}`);
  else bad(`extension.js calls ${missing.join(', ')} on the view, which has no such method`);
  if (/\bsweepOrphans\b[^\n]*require\('\.\/src\/workplan'\)/.test(ext) && /const r = sweepOrphans\(\);/.test(ext)) {
    ok('the sweep of abandoned plans is the module\'s function, imported as such');
  } else bad('the sweep of abandoned plans is not called through the module');
  fs.rmSync(stub, { force: true });
}

console.log('\nthe latest tool call, on the working line of a folded conversation');
{
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'src', 'page', '87-plain-view.js'), 'utf8');
  let searches = 0, busy = false, prompts = 0;
  const box = {
    out: {},
    isOff: () => false,
    fmt: (ms) => 'T' + ms,
    dur: (ms) => (ms > 0 ? Math.round(ms / 1000) + 's' : ''),
    setStyle() {}, setLabel() {}, SEND: 'z',
    sigOn: (name) => name === 'visiblyBusy' && busy,
    sigLen: (name) => (name === 'permissionRequests' ? prompts : 0),
    window: { innerHeight: 800, localStorage: { getItem: () => '1', setItem() {} } },
    document: { querySelector: () => null, querySelectorAll: () => { searches++; return []; } },
  };
  new vm.Script(`(function(){${fragment}\n;out.begin = beginToolSweep; out.note = noteTool; out.end = endToolSweep;` +
    ` out.text = toolClockText; out.paint = paintToolClock; out.now = function(){ return toolNow; };})()`,
    { filename: '87-plain-view.js' }).runInNewContext(box);
  const o = box.out, T = 1000000;
  const call = (at, name, doneAt, type = 'tool_use') => ({ message: { timestamp: at }, block: { content: { type, name }, cceResultAt: doneAt } });
  const sweep = (turnAt, calls) => { o.begin(turnAt); for (const c of calls) o.note(c, c.block.content.type); o.end(); };
  const expect = (got, want, label) => (got === want ? ok(label) : bad(`${label}: got "${got}", expected "${want}"`));

  sweep(T, [call(T + 1000, 'Read', T + 2000), call(T + 3000, 'Bash')]);
  expect(o.text(o.now(), T + 8000, false), `Bash running for 5s (since T${T + 3000})`, 'a call with no result yet reads as running, with its start');
  expect(o.text(o.now(), T + 8000, true), 'Bash 5s', 'and has a short form for a narrow panel');
  sweep(T, [call(T + 1000, 'Read', T + 2000), call(T + 3000, 'Bash', T + 9000)]);
  expect(o.text(o.now(), T + 12000, false), `last tool Bash finished 3s ago (T${T + 9000})`, 'once it is back, how long ago it finished');
  sweep(T, []);
  expect(o.now().at, T + 3000, 'a sweep that meets no tool call in the same turn keeps the figures it had');
  sweep(T + 20000, [call(T + 3000, 'Bash', T + 9000)]);
  expect(o.text(o.now(), T + 25000, false), 'no tool call yet this turn (5s since your message)', 'a new turn with no call says so, timed from your message');
  sweep(T + 20000, [call(T + 3000, 'Bash')]);
  expect(o.now().open, 0, 'a call from an earlier turn that never came back is not running');
  sweep(T, [call(T + 1000, 'Read'), call(T + 2000, 'Grep')]);
  expect(o.text(o.now(), T + 6000, false), `2 tools running for 5s (since T${T + 1000})`, 'two open calls are counted, timed from the first');
  sweep(T, [call(T + 1000, 'web_search', undefined, 'server_tool_use')]);
  expect(o.now().open, 0, 'a server tool, whose result time is not recorded, is never counted as running');
  box.isOff = () => true;
  sweep(T, [call(T + 5000, 'Edit')]);
  expect(o.now().name, 'web_search', 'switched off, nothing is gathered');
  box.isOff = () => false;

  o.paint(); o.paint();
  expect(searches, 0, 'not busy: the page is not searched at all');
  busy = true; prompts = 1; o.paint();
  expect(searches, 0, 'busy but waiting on a permission prompt, which hides the indicator: not searched either');
  prompts = 0; o.paint(); o.paint(); o.paint();
  expect(searches, 1, 'busy with no indicator found: searched once, then not again within a few seconds');


  // Where the indicator is drawn: two rows the panel can draw it in, found by the words a screen reader hears.
  let clock = 1e6, pageRows = [];
  const span = (box) => ({ textContent: 'Claude is working', parentElement: box });
  const row = (getSpans) => ({ isConnected: true, querySelectorAll: () => getSpans(), contains: (x) => getSpans().some((s) => s.parentElement === x) });
  let boxB = { isConnected: true }, spansB = [span(boxB)];
  const rowA = row(() => []), rowB = row(() => spansB);
  const box2 = { out: {}, isOff: () => false, fmt: String, dur: String, setStyle() {}, setLabel() {}, SEND: 'z',
    sigOn: () => true, sigLen: () => 0, Date: { now: () => clock },
    window: { innerHeight: 800, localStorage: { getItem: () => '1', setItem() {} } },
    document: { querySelector: () => null, querySelectorAll: () => { searches++; return pageRows; } } };
  searches = 0;
  new vm.Script(`(function(){${fragment}\n;out.find = findWorking;})()`, { filename: '87-plain-view.js' }).runInNewContext(box2);
  const find = box2.out.find;
  pageRows = [rowA];
  expect(find(), null, 'an indicator not yet drawn is not found');
  pageRows = [rowA, rowB]; clock += 1000;
  expect(find() === null && searches === 1, true, 'and the page is not searched again within a few seconds');
  clock += 3000;
  expect(find(), rowB, 'after that it is found in whichever row it is drawn');
  expect(find() === rowB && searches === 2, true, 'and kept: finding it again searches nothing');
  boxB.isConnected = false; boxB = { isConnected: true }; spansB = [span(boxB)];
  expect(find() === rowB && searches === 2, true, 'a new turn draws a new indicator in the same row, found without searching the page');
}

console.log('\na window whose install was replaced by a rebuild of the same version');
{
  const removal = require('../src/removal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-replaced-'));
  const write = (meta) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.8', ...(meta ? { __metadata: meta } : {}) }));
  write({ installedTimestamp: 1000 });
  const loaded = removal.installStamp(dir);
  const cases = [
    [loaded === 1000 && removal.replacedSince(dir, loaded) === false, 'the same install: not replaced'],
    [(write({ installedTimestamp: 2000 }), removal.replacedSince(dir, loaded) === true), 'installed again over itself: replaced'],
    [removal.replacedSince(dir, 0) === false, 'no stamp read at start: never counted as replaced'],
    [(write(null), removal.replacedSince(dir, loaded) === false), 'a manifest without install metadata: not replaced'],
    [removal.replacedSince(path.join(dir, 'gone'), loaded) === false && removal.installStamp(path.join(dir, 'gone')) === 0,
      'a manifest that cannot be read: not replaced, and no stamp'],
  ];
  for (const [good, label] of cases) (good ? ok : bad)(label);
  fs.rmSync(dir, { recursive: true, force: true });
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const guarded = [
    ['writing the live stylesheet', /const writeLiveNow = \(\) => \{\s*if \(uninstalling\(\) \|\| replaced\(\)\) return;/],
    ['patching or restoring', /async function sync\([^)]*\) \{\s*if \(replaced\(\)\) \{/],
    ['the timed refresh', /if \(removed\(\) \|\| !enabled\(\) \|\| uninstalling\(\) \|\| replaced\(\)\) return;\s*scanBackground\(\);/],
  ];
  const missing = guarded.filter(([, re]) => !re.test(ext)).map(([what]) => what);
  if (!missing.length) ok('a replaced window writes nothing shared: ' + guarded.map(([what]) => what).join(', '));
  else bad('not guarded against a replaced install: ' + missing.join(', '));
}

const ran = `${passed} passed` + (skipped ? `, ${skipped} skipped for want of an install here` : '');
console.log(failures ? `\n${failures} check(s) failed (${ran})` : `\nall checks passed (${ran})`);
process.exit(failures ? 1 : 0);

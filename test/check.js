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
  if (plan.STATES.includes('doing') && plan.STATES.length === 6) ok('six states, doing among them');
  else bad(`the states are ${plan.STATES.join()}`);

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

  for (const [what, enabled] of [['on by default', undefined], ['on', true]]) {
    const t = stage(enabled);
    const injected = run('inject-work-plan.py', t.dir, { session_id: session, hook_event_name: 'UserPromptSubmit' });
    const nudged = run('nudge-work-plan.py', t.dir,
      { session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' });
    if (injected.includes('a row') && nudged.includes('neither read nor updated')) ok(`${what}: the rows arrive and the reminder speaks`);
    else bad(`${what}: injected ${injected.length} bytes, nudge ${nudged.length} bytes`);
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
  {
    const t = stage(false);
    const injected = run('inject-work-plan.py', t.dir, { session_id: session, hook_event_name: 'UserPromptSubmit' });
    if (!injected) ok('off: nothing is put in front of the model, which is where the tokens went');
    else bad(`off: still injected ${injected.length} bytes`);

    const nudged = run('nudge-work-plan.py', t.dir,
      { session_id: session, transcript_path: t.transcript, hook_event_name: 'Stop' });
    if (!nudged) ok('off: the end of a turn says nothing');
    else bad(`off: still nudged ${JSON.stringify(nudged.slice(0, 80))}`);

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

const ran = `${passed} passed` + (skipped ? `, ${skipped} skipped for want of an install here` : '');
console.log(failures ? `\n${failures} check(s) failed (${ran})` : `\nall checks passed (${ran})`);
process.exit(failures ? 1 : 0);

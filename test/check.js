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
const { pickShape } = require('../src/edits');

let failures = 0;
const ok = (msg) => console.log('  ok    ' + msg);
const bad = (msg) => { failures++; console.log('  FAIL  ' + msg); };

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

/* ── 4. the edits, against a pristine bundle ── */
/* Any patch of this kind announces itself with a marker comment. Recognising the shape, rather than one particular
   name, keeps a bundle that some other patcher owns from being mistaken for a pristine one - which would otherwise
   show up as every edit matching zero times, a confusing way to say "someone else got here first". */
const FOREIGN_MARKER = /^\/\* [A-Z][A-Z0-9-]{3,} v\d+ \*\//m;

function pristine(file, adapter) {
  const candidates = [
    [file + adapter.BACKUP_SUFFIX, 'our backup'],
    [file, 'the file itself'],
  ];
  for (const [p, from] of candidates) {
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (src.includes(adapter.ANY_MARK)) continue;
    const foreign = src.match(FOREIGN_MARKER);
    if (foreign) return { foreign: foreign[0].trim(), from };
    return { src, from };
  }
  return null;
}

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

function extensionsDirs() {
  const home = os.homedir();
  return [
    process.env.VSCODE_EXTENSIONS,
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode', 'extensions'),
  ].filter(Boolean);
}

console.log('\nedits');
const explicit = process.argv.slice(2);
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
  if (!seen) console.log('  note  no Claude Code install found; pass a bundle path to check the edits');
}

reportUnusedShapes();

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
  console.log('  note  skipped: checking named bundles, not this machine');
} else {
  const installed = extensionsDirs()
    .map((d) => path.join(d, 'xnerv.claude-code-extras-1.0.0'))
    .find((d) => fs.existsSync(d));
  if (!installed) {
    console.log('  note  this extension is not installed here; nothing to compare');
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
    console.log('  note  no git history to read here, so commit messages were not scanned');
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

  /* A tree holding the transcripts named in `live` and a plan for each id in `plans`, with the given age. */
  const build = (live, plans) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-sweep-'));
    const projects = path.join(root, 'projects');
    const dir = path.join(root, 'plans');
    fs.mkdirSync(path.join(projects, '-some-project'), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const s of live) fs.writeFileSync(path.join(projects, '-some-project', s + '.jsonl'), '{}\n');
    for (const [s, age] of plans) {
      const f = path.join(dir, s + '.json');
      fs.writeFileSync(f, '{"nodes":[]}');
      fs.utimesSync(f, age / 1000, age / 1000);
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
  if (titles(plan.openFirst(mixed)) === 'b,d,f,a,c,e') ok('unfinished rows come first, each group in the file order');
  else bad(`the drawn order is ${titles(plan.openFirst(mixed))}, expected b,d,f,a,c,e`);

  const allDone = [N('a', 'done'), N('b', 'dropped')];
  const allOpen = [N('a', 'todo'), N('b', 'parked')];
  if (plan.openFirst(allDone) === allDone && plan.openFirst(allOpen) === allOpen) {
    ok('a list with nothing to separate is handed back as it came');
  } else bad('a list needing no reordering is copied anyway');

  if (titles(plan.openFirst([])) === '' && titles(plan.openFirst(null)) === '') ok('no rows, and no rows at all, are fine');
  else bad('an empty or missing list is not handled');

  /* The id is built from the row's place in the file, so closing a row moves it on screen without renaming it. */
  const rowsOf = (nodes) => plan.openFirst(
    nodes.map((n, i) => ({ node: n, key: 'p/' + i + ':' + n.title })), (r) => r.node.state);
  const idOf = (rows, t) => (rows.find((r) => r.node.title === t) || {}).key;
  const before = rowsOf([N('a', 'done'), N('b', 'todo'), N('c', 'todo')]);
  const after = rowsOf([N('a', 'done'), N('b', 'done'), N('c', 'todo')]);
  const moved = before.indexOf(before.find((r) => r.node.title === 'b'))
    !== after.indexOf(after.find((r) => r.node.title === 'b'));
  if (moved && idOf(before, 'b') === idOf(after, 'b') && idOf(before, 'c') === idOf(after, 'c')) {
    ok('a row that closes moves on screen and keeps its id');
  } else bad(`closing a row renames it (moved: ${moved}, was ${idOf(before, 'b')}, now ${idOf(after, 'b')})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

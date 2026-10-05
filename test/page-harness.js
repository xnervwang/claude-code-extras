// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Runs the real injected script in a headless browser against a stand-in panel, and hands back what it counted.
 *
 * What is measured is counts, never milliseconds: how many sweeps an idle page ran, how many order comparisons and
 * queries a sweep made, how many DOM changes the script caused when nothing was happening. A count is the same on every
 * machine, so a threshold on it can be tight; a time is not, and a test that fails on a slow runner is soon ignored.
 *
 * The stand-in is built to the script's own assumptions - class-name fragments, and the props React hangs on each
 * element - so it tests this code against what it expects of the panel, not the panel itself. A change upstream is the
 * runtime self-check's to report, and test/against-latest.js's.
 *
 * Two things about the browser that make a broken measurement look like a clean one, both met while writing this:
 * - Under a virtual time budget an animation frame fires once and never again, and sweeps run in one. Without the shim
 *   below every page measures a single sweep, loop or no loop.
 * - The result is read out of the dumped DOM, and the scripts are part of that DOM, so the marker is assembled at run
 *   time and never appears in the source as one string.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = 'CCE-RESULT:';

function onPath(name) {
  const r = cp.spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return r.status === 0 && p ? p : '';
}

/** A Chrome or Chromium to run, or ''. CCE_BROWSER names one outright. */
function findBrowser() {
  if (process.env.CCE_BROWSER) return fs.existsSync(process.env.CCE_BROWSER) ? process.env.CCE_BROWSER : '';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = onPath(name);
    if (p) return p;
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort(); } catch (_) { /* none */ }
  for (const d of dirs.reverse()) {
    const p = path.join(cache, d, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/* Runs before the injected script: the frame shim, the stored plain-view choice, the counters, and the stand-in panel.
   The counters wrap browser methods rather than anything of ours, so the script under test is byte for byte the one
   that ships. */
const SETUP = String.raw`
  window.requestAnimationFrame = function(cb){ return setTimeout(function(){ cb(performance.now()); }, 16); };
  try { localStorage.setItem('cce.plain', CFG.plain ? '1' : '0'); } catch (e) {}
  var COUNT = { cdp: 0, qsa: 0, text: 0 };
  (function(){
    var cdp = Node.prototype.compareDocumentPosition;
    Node.prototype.compareDocumentPosition = function(o){ COUNT.cdp++; return cdp.call(this, o); };
    var dq = Document.prototype.querySelectorAll, eq = Element.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(s){ COUNT.qsa++; return dq.call(this, s); };
    Element.prototype.querySelectorAll = function(s){ COUNT.qsa++; return eq.call(this, s); };
    var tc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', { configurable: true, enumerable: tc.enumerable, get: tc.get,
      set: function(v){ COUNT.text++; tc.set.call(this, v); } });
  })();

  var FIBER = '__reactFiber$ccetest';
  var SUB = 'toolu_sub1';
  var session = {
    agentMapAgents: { value: new Map(CFG.subagent ? [[SUB, { toolUseId: SUB, description: 'Survey the hooks' }]] : []) },
    subagentTasks: { value: new Map() },
  };
  var top = { memoizedProps: { session: session }, return: null };
  var list = document.getElementById('list'), uuid = 0, lastRow = null, compactions = 0;
  var hang = function(el, block, message){
    el[FIBER] = { memoizedProps: { content: block }, return: { memoizedProps: { message: message }, return: top } };
  };
  var user = function(i, ts){
    var u = document.createElement('div');
    u.className = 'userMessage_k3j2';
    u.innerHTML = '<div class="content_c1"><span>question ' + i + ' about the hooks</span></div>';
    hang(u, { content: { type: 'text', text: 'question ' + i } }, { uuid: 'u' + (++uuid), timestamp: ts });
    list.appendChild(u);
  };
  var KINDS = ['thinking', 'tool_use', 'text'];
  var reply = function(ts, owner){
    var m = document.createElement('div');
    m.setAttribute('data-testid', 'assistant-message');
    var message = { uuid: 'a' + (++uuid), timestamp: ts };
    if (owner) message.parentToolUseId = owner;
    for (var r = 0; r < KINDS.length; r++) {
      var row = document.createElement('div');
      row.className = 'timelineMessage_ab12';
      row.innerHTML = '<div class="markdown_m1"><p><span>a</span><code>b</code><span>c</span></p><p><span>d</span></p></div>';
      var block = KINDS[r] === 'tool_use'
        ? { content: { type: 'tool_use', name: 'Bash', input: { command: 'ls' } } }
        : { content: { type: KINDS[r], text: 'x' } };
      hang(row, block, message);
      m.appendChild(row);
      lastRow = row.firstChild;
    }
    list.appendChild(m);
  };
  var compaction = function(){
    var d = document.createElement('details');
    d.className = 'compactSummary_c9';
    d.innerHTML = '<summary>Conversation compacted</summary><div>summary</div>';
    list.appendChild(d);
    compactions++;
  };
  var t0 = Date.now() - (CFG.turns + 2) * 600000;
  var turn = function(i){
    if (i && i % CFG.compactEvery === 0) compaction();
    var ts = t0 + i * 600000;
    user(i, ts);
    for (var k = 0; k < 3; k++) reply(ts + 1000 * (k + 1), CFG.subagent && i === CFG.turns - 2 && k === 1 ? SUB : '');
  };
  for (var i = 0; i < CFG.turns; i++) turn(i);
  var addTurn = function(){ turn(CFG.turns); };
`;

/* Runs after it: three phases on the page's own clock, then the readout. Idle first - the page has booted and nothing
   happens; then a reply growing, which is what drives sweeps in use; then a new prompt, which rebuilds the contents
   list. */
const PHASES = String.raw`
  var R = { script: !!window.__cceStats };
  var stats = function(){ return window.__cceStats ? window.__cceStats() : null; };
  var snap = function(){ var s = stats(); return { n: s ? s.n : -1, cdp: COUNT.cdp, qsa: COUNT.qsa, text: COUNT.text }; };
  var finish = function(){ document.getElementById('out').textContent = 'CCE-' + 'RESULT:' + JSON.stringify(R); };
  var later = function(ms, f){
    setTimeout(function(){ try { f(); } catch (e) { R.error = String(e && e.stack || e); finish(); } }, ms);
  };
  var mut = { on: false, child: 0, attr: 0, chars: 0 };
  new MutationObserver(function(rs){
    if (!mut.on) return;
    for (var i = 0; i < rs.length; i++) {
      if (rs[i].type === 'childList') mut.child++; else if (rs[i].type === 'attributes') mut.attr++; else mut.chars++;
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  var a, b;
  /* Idle starts once the boot has finished, judged by the sweep count holding still for a second after the first sweep
     - a fixed moment would sometimes land before the script had put its controls in, and a count still at zero is a
     script that has not started rather than one that has stopped. A page that never holds still starts at the cap
     instead, and is counted as it is. */
  var settle = function(lastN, quiet, waited){
    var n = snap().n;
    quiet = n > 0 && n === lastN ? quiet + 1 : 0;
    if (quiet >= 5 || waited >= CFG.settleCapMs) { R.settledAfter = waited; R.bootSweeps = n; return idle(); }
    later(200, function(){ settle(n, quiet, waited + 200); });
  };
  var idle = function(){
    a = snap(); mut.on = true;
    later(CFG.idleMs, function(){
      b = snap(); mut.on = false;
      R.idleSweeps = b.n - a.n;
      R.idleChild = mut.child; R.idleAttr = mut.attr; R.idleChars = mut.chars; R.idleText = b.text - a.text;
      R.viewButton = !!document.querySelector('[data-cce-view]');
      R.plainButton = !!document.querySelector('[data-cce-plain-btn]');
      var rule = document.querySelector('style[data-cce-plain]');
      R.plainRule = rule ? rule.textContent.length : -1;
      a = snap();
      grow(0);
    });
  };
  /* A reply growing, which is what drives sweeps in use. */
  var grow = function(k){
    if (k === CFG.grows) return later(400, grown);
    var s = document.createElement('span');
    s.appendChild(document.createTextNode(' more'));
    lastRow.appendChild(s);
    later(300, function(){ grow(k + 1); });
  };
  var grown = function(){
    b = snap();
    var s = stats(), last = s && s.last;
    R.growSweeps = b.n - a.n; R.growCdp = b.cdp - a.cdp; R.growQsa = b.qsa - a.qsa; R.growText = b.text - a.text;
    R.fiber = last ? last.fiber : -1; R.full = last ? last.full : -1;
    R.msgs = last ? last.msgs : -1; R.bubbles = last ? last.bubbles : -1;
    a = snap();
    addTurn();
    later(800, rebuilt);
  };
  /* A new prompt, which is what rebuilds the contents list. */
  var rebuilt = function(){
    b = snap();
    R.rebuildSweeps = b.n - a.n; R.rebuildCdp = b.cdp - a.cdp;
    R.prompts = CFG.turns + 1; R.compactions = compactions;
    finish();
  };
  later(500, function(){ settle(-1, 0, 500); });
`;

function page(cfg, script) {
  return '<!doctype html><html><head></head><body><pre id="out"></pre>'
    + '<div id="list" style="overflow-y:auto;height:600px"></div>'
    + '<form><div class="inputRow_r1">'
    + '<button type="button" class="menuButton_x1">m</button>'
    + '<button type="button" class="usageButtonV2_u7" aria-label="40% of context used">40%</button>'
    + '<div class="mode_m2">mode</div><button type="submit" data-permission-mode="default">send</button>'
    + '</div></form>'
    + '<script>var CFG = ' + JSON.stringify(cfg) + ';' + SETUP + '</script>'
    + '<script>' + script + '</script>'
    + '<script>' + PHASES + '</script>'
    + '</body></html>';
}

/**
 * One stand-in panel, run to the end. `cfg`: turns, compactEvery, plain, subagent, and the phase lengths. Resolves to the
 * page's counts, or { error } saying why there are none.
 */
const DEFAULTS = { turns: 100, compactEvery: 20, plain: true, subagent: true, settleCapMs: 6000, idleMs: 3000, grows: 8 };

function run(browser, cfg, script) {
  const full = Object.assign({}, DEFAULTS, cfg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-page-'));
  try {
    const file = path.join(dir, 'panel.html');
    fs.writeFileSync(file, page(full, script || require('../src/webview').SCRIPT));
    const budget = full.settleCapMs + full.idleMs + full.grows * 300 + 3000;
    /* No --user-data-dir. Headless already starts from a temporary profile of its own, which is what keeps it apart
       from a browser the person is using; naming a directory instead makes it set that up as a lasting profile, and
       that first-run setup held every run here until the process was killed. */
    const r = cp.spawnSync(browser, ['--headless=new', '--no-sandbox', '--disable-gpu',
      '--virtual-time-budget=' + budget, '--dump-dom', 'file://' + file], { encoding: 'utf8', timeout: 120000 });
    const at = (r.stdout || '').indexOf(MARK);
    if (at === -1) return { error: 'no result in the page (exit ' + r.status + (r.error ? ', ' + r.error.message : '') + ')' };
    const json = r.stdout.slice(at + MARK.length, r.stdout.indexOf('<', at));
    return JSON.parse(json.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } catch (e) {
    return { error: e.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { findBrowser, run, DEFAULTS };

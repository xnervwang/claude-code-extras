'use strict';
/*
 * First patch target: the Claude Code chat panel (webview/index.js inside the Claude Code extension).
 *
 * The panel is an ordinary web page. Everything this file adds is either information the panel already receives and
 * throws away, or a control built from data it already holds — nothing is fetched, guessed or persisted.
 *
 * Nine edits, each matching a code SHAPE rather than a name, because identifiers in a minified bundle change with
 * every build:
 *
 *   message builder    Each chat message is rebuilt from the CLI message, but `timestamp` is dropped, so a rebuilt
 *                      message falls back to Date.now() and reopened history would read "now". Pass the real time.
 *   tool result        When a tool result arrives, record its time on the tool row, so a call can show start and end.
 *   session createdAt  Carry the session's creation time into the session-list model.
 *   session time       Wrap the relative time in the list with the absolute date range.
 *   context meter      Two: move the three artwork states' switch points to each arc's own extent, and drop the guard
 *                      that hides the meter while more than half the window is still free.
 *   agent map          Three: a section for this session's scheduled prompts, the footer button opening for a
 *                      schedule even with no agent, and a label that then does not read "0 agents".
 *
 * Then this file appends a script that reads those times back out of React props and marks rows through an attribute,
 * plus the table of contents, the view filter, the context breakdown and the chime. A row whose real time it cannot
 * read shows nothing rather than a guessed time.
 *
 * NOTHING OF OURS GOES INSIDE A NODE THE PANEL OWNS. Reading a node's position, adding a sibling, setting an attribute
 * or an inline style are all fine; appending a child is not. One line appended to the panel's own usage tooltip
 * collided with its next redraw, and after that throw the page stopped handling clicks and keys altogether - the stop
 * button and Escape died together, with nothing visible to say why. Where a section really has to sit among the
 * panel's own children, an edit hands our code the panel's element factory and the panel renders what we return.
 *
 * LIVE SETTINGS, NO RELOAD. How the marks look — on or off, and the user's message color — is not baked into the
 * script. It lives in a stylesheet next to the panel that the extension rewrites when a setting changes. The panel's
 * security policy allows stylesheets and images from its own folder, so the script polls a one-pixel SVG whose WIDTH
 * is a revision number and reloads the stylesheet only when that number changes. Only installing or upgrading the
 * patch itself needs a reload.
 *
 * NEITHER OF THOSE LOADS MAY BLOCK THE FIRST PAINT. Both files are on a remote file system here, so a naive load holds
 * the panel blank for a round trip every time it opens. The stylesheet goes in under media=print and is switched to all
 * once it has arrived; its address carries the revision rather than the clock, so a panel can reuse one it already has;
 * and the probe is an image, which never blocked anything. The full account is the fourth constraint in README.md.
 *
 * DISCIPLINE. Every edit must match exactly once or nothing at all is written; the result must parse; the untouched
 * original is saved beside the file before the first write; the replacement is atomic; and Remove or uninstall puts
 * the original back. A build whose shape does not match is left alone with a warning rather than patched on a guess.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const { applyEdits } = require('./edits');

const VERSION = 32;

/* The marker written into the patched file has to answer one question: is the code in
 * the panel the code this tree produces? A hand-maintained number answers it only while
 * someone remembers to change it, and forgetting is silent in the worst way -- packaging,
 * installing and reloading all report success while the panel keeps running the old code,
 * so the symptom is an edit that has no effect anywhere and no step that complained.
 *
 * So the number is decoration and the digest is the answer: it covers the injected script
 * and the edits made inside the bundle, which is everything patching changes. Nothing to
 * remember, and a stale patch cannot look current. VERSION stays because a human reading
 * the file wants a number, not a hash. */
const MARK_PREFIX = '/* CLAUDE-CODE-EXTRAS-WEBVIEW ';
const ANY_MARK = MARK_PREFIX;
const BACKUP_SUFFIX = '.claude-code-extras-webview.bak';
/*
 * Live settings. How the marks look - on or off, and the colour of the user's own messages - is not baked into the
 * injected script. It lives in a stylesheet written into the panel's own folder, which the page reloads when a
 * revision number changes. The indirection exists because the panel's content security policy refuses an injected
 * <style> element but does allow a stylesheet served from that folder.
 */
const ATTR = 'data-cce-ts';
const LIVE_CSS = 'claude-code-extras.css';
const LIVE_REV = 'claude-code-extras.rev.svg';
/*
 * How often the page re-checks that revision number. Every check is a file request, and on a remote host that is a
 * round trip over the remote channel - once per open panel, whether or not anyone is looking at it. So this trades how
 * quickly a changed setting shows up against how much traffic idle panels generate; a couple of seconds still reads as
 * immediate to someone who just flipped a switch.
 */
const POLL_MS = 3000;

/** How the panel marks the user's own messages. */
const USER_SELECTOR = '[class*="userMessage_"]';

const STAMP_CSS = `[${ATTR}]::before{content:attr(${ATTR});display:inline-block;margin-inline-end:.7em;`
  + 'unicode-bidi:isolate;vertical-align:baseline;font-family:var(--vscode-editor-font-family,monospace);'
  + 'font-size:.8em;font-weight:normal;font-style:normal;opacity:.6;white-space:nowrap;}';

/** A CSS colour the user typed, or '' when it is not a plain colour - nothing else may reach the stylesheet. */
function safeColor(value) {
  const v = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^[a-zA-Z]{3,30}$/.test(v) || /^(rgb|rgba|hsl|hsla)\([0-9.,%\s/deg]+\)$/.test(v)) return v;
  return '';
}

/*
 * The scheduled prompts, carried to the page as a custom property.
 *
 * Base64, because the value has to survive as a CSS string and a prompt is full of quotes and newlines that a
 * stylesheet would reject; base64 is nothing but letters, digits and three punctuation marks. The page is the only
 * consumer, so this is a private encoding between the two halves rather than anything a user sees.
 */
function scheduleProperty(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return '';
  return `:root{--cce-schedule:"${Buffer.from(JSON.stringify(tasks), 'utf8').toString('base64')}";}\n`;
}

/** The live stylesheet for one set of settings. */
function liveCss(opts = {}) {
  const on = opts.enabled !== false;
  const color = safeColor(opts.userColor);
  let css = `/* Claude Code Extras live settings - written by the extension */\n:root{--cce-on:${on ? 1 : 0};}\n`;
  if (on) css += STAMP_CSS + '\n';
  if (color) css += `${USER_SELECTOR},${USER_SELECTOR} *{color:${color} !important;}\n`;
  if (on) css += scheduleProperty(opts.tasks);
  return css;
}

/*
 * The in-page script is assembled from the fragments in src/page, in file-name order, inside one closure.
 *
 * They are real .js files rather than one template literal on purpose. In a template literal every backslash has to be
 * doubled to survive evaluation, and getting that wrong fails only at runtime: `/\s+/` evaluated to `/s+/` that way
 * and quietly replaced the letter s in every label it passed through. As files, an editor, a linter and `node --check`
 * all read them as the code they are.
 *
 * They are fragments, not modules: no imports, no exports, and every binding one declares is visible to all the
 * others. File-name order is load order, so anything that runs on load belongs in the last fragment - by then every
 * function it calls has been assigned.
 */
const PAGE_DIR = path.join(__dirname, 'page');

function pageFragments() {
  return fs.readdirSync(PAGE_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({ name: f, code: fs.readFileSync(path.join(PAGE_DIR, f), 'utf8').replace(/\s+$/, '') }));
}

/** What the extension decides and the page cannot: the mark attribute, the live stylesheet, the fallback rules. */
function configBlock() {
  return [
    `  var ATTR = ${JSON.stringify(ATTR)};`,
    `  var STAMP_CSS = ${JSON.stringify(STAMP_CSS)};`,
    `  var LIVE_CSS = ${JSON.stringify(LIVE_CSS)};`,
    `  var LIVE_REV = ${JSON.stringify(LIVE_REV)};`,
    `  var POLL_MS = ${POLL_MS};`,
  ].join('\n');
}

/** The injected script without its marker: the marker is a digest of this, so it cannot
 *  also be part of it. */
function buildBody() {
  const parts = pageFragments().map((p) => `  /* ${p.name} */\n${p.code}`);
  return [';(function(){try{',
    '  if (window.__claudeCodeExtras) return; window.__claudeCodeExtras = true;',
    configBlock(), ...parts, '}catch(e){}})();'].join('\n');
}

const SCRIPT_BODY = buildBody();

const EDITS = [
  {
    name: 'message builder',
    re: /return new ([\w$]+)\(([\w$]+)\.type,([\w$]+),\{uuid:\2\.uuid,foldedIntoTurn:/g,
    to: (m, cls, msg, content) => `return new ${cls}(${msg}.type,${content},{uuid:${msg}.uuid,timestamp:(typeof ${msg}.timestamp==="string"&&Date.parse(${msg}.timestamp))||void 0,foldedIntoTurn:`,
  },
  {
    name: 'tool result',
    re: /for\(let ([\w$]+) of ([\w$]+)\.message\.content\)if\(\1\.type==="tool_result"\)\{let ([\w$]+)=([\w$]+)\(([\w$]+),\1\.tool_use_id\);if\(\3\)\3\.setToolResult\(\1\)\}/g,
    to: (m, item, msg, row, find, sess) => `for(let ${item} of ${msg}.message.content)if(${item}.type==="tool_result"){let ${row}=${find}(${sess},${item}.tool_use_id);if(${row}){${row}.setToolResult(${item});${row}.cceResultAt=(typeof ${msg}.timestamp==="string"&&Date.parse(${msg}.timestamp))||void 0}}`,
  },
  {
    // Three sibling factories assign sessionId and transcriptOnDisk the same way; what tells this one apart is that
    // it goes on to set lastModifiedTime. The match stops at that field name and does not look at what it is set
    // to, because that expression is the kind of thing a release changes.
    name: 'session list createdAt',
    re: /([\w$]+)\.sessionId\.value=([\w$]+)\.id,\1\.transcriptOnDisk=!0,\1\.lastModifiedTime\.value=/g,
    to: (m, y, s) => `${y}.sessionId.value=${s}.id,${y}.transcriptOnDisk=!0,${y}.cceCreatedAt=${s}.createdAt,${y}.lastModifiedTime.value=`,
  },
  {
    name: 'session list time render',
    re: /children:([\w$]+)\(([\w$]+)\.lastModifiedTime\.value\)/g,
    to: (m, f, j) => `children:(typeof window.__cceSpan==="function"?window.__cceSpan(${f}(${j}.lastModifiedTime.value),${j}.lastModifiedTime.value,${j}.cceCreatedAt):${f}(${j}.lastModifiedTime.value))`,
  },
  {
    // The three artwork states cover half, three quarters and almost all of the circle, but the component picks
    // them at 62.5% and 87% - so between 50% and 62.5% used it draws a half arc that cannot express the figure,
    // and the reading stalls. Choosing each state at the limit of what its arc can show removes both stalls; the
    // in-page script then trims the chosen arc to the exact figure.
    name: 'context meter state thresholds',
    re: /if\(([\w$]+)<[\d.]+\)return 50;if\(\1<[\d.]+\)return 75;return 99/g,
    to: (m, pct) => `if(${pct}<=50)return 50;if(${pct}<=75)return 75;return 99`,
  },
  {
    // The meter hides itself while more than half the window is free. Only that clause goes; the one that
    // suppresses it before a real window size has arrived stays, since the figure is meaningless without one.
    name: 'context meter always visible',
    re: /if\(([\w$]+)===null\)\{if\(([\w$]+)===0\)return null;if\(([\w$]+)>=\d+\)return null\}/g,
    to: (m, override, window) => `if(${override}===null){if(${window}===0)return null}`,
  },
  {
    /*
     * A section for this session's scheduled prompts, at the top of the agent map.
     *
     * The page is handed the element factory from this scope, so it returns a real element tree rather than a string -
     * the section has a heading and one collapsible row per prompt. Returning null when there is nothing to show is how
     * a child opts out, so an unpatched-looking panel is the normal case.
     *
     * The anchor is the panel's own title and its children array, with whatever props sit between them skipped: the
     * dialog's size and scrolling have been reshaped upstream before, and none of that changes where a child goes.
     */
    name: 'agent map scheduled section',
    re: /([\w$]+)\(([\w$]+),\{title:"Agent map",([^[]*?)children:\[/g,
    to: (m, h, dialog, between) =>
      `${h}(${dialog},{title:"Agent map",${between}children:[(typeof window.__cceSchedule==="function"?window.__cceSchedule(${h}):null),`,
  },
  {
    // The footer's agent button appears only once an agent exists. A scheduled prompt is the same kind of thing -
    // something this conversation set running in the background - and the map is where it is shown, so it opens the
    // button too. The original condition is kept first so the button behaves exactly as before whenever an agent is up.
    name: 'agent button also for schedules',
    re: /([\w$]+)&&([\w$]+)\(([\w$]+),\{session:([\w$]+),onOpen:([\w$]+)\}\)/g,
    to: (m, gate, h, button, session, onOpen) =>
      `(${gate}||(typeof window.__cceScheduleCount==="function"&&window.__cceScheduleCount()>0))&&${h}(${button},{session:${session},onOpen:${onOpen}})`,
  },
  {
    // With the button open for schedules alone, its label would read "0 agents". The label is built from the count in
    // one place, so the page gets to amend the finished text - the only field that needs to know about both kinds.
    name: 'agent button label',
    re: /function ([\w$]+)\(\{count:([\w$]+),dot:([\w$]+),onOpen:([\w$]+)\}\)\{let ([\w$]+)=([\w$]+)\(\2\),/g,
    to: (m, fn, count, dot, onOpen, label, make) =>
      `function ${fn}({count:${count},dot:${dot},onOpen:${onOpen}}){let ${label}=(typeof window.__cceAgentsLabel==="function"?window.__cceAgentsLabel(${make}(${count}),${count}):${make}(${count})),`,
  },
];

/** Pure transform. Returns { out, chosen } or { error }. Never partially applies. */
const MARK = MARK_PREFIX + 'v' + VERSION + '-' + crypto.createHash('sha256')
  .update(SCRIPT_BODY).update('\n').update(JSON.stringify(EDITS))
  .digest('hex').slice(0, 12) + ' */';

const SCRIPT = ['', MARK, SCRIPT_BODY, ''].join('\n');


function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'already patched' };
  const r = applyEdits(src, EDITS);
  if (r.error) return { error: r.error };
  const out = r.out + '\n' + SCRIPT;
  try { new vm.Script(out, { filename: 'index.js' }); }
  catch (err) { return { error: `patched code does not parse: ${err.message}` }; }
  return { out, chosen: r.chosen };
}

function webviewFile(claudeExtensionPath) { return path.join(claudeExtensionPath, 'webview', 'index.js'); }
function liveFiles(claudeExtensionPath) {
  const dir = path.join(claudeExtensionPath, 'webview');
  return { css: path.join(dir, LIVE_CSS), rev: path.join(dir, LIVE_REV) };
}

/** State of one Claude Code install: 'patched' (this version), 'outdated' (another version of this patch), 'clean', 'missing'. */
function status(claudeExtensionPath) {
  const file = webviewFile(claudeExtensionPath);
  if (!fs.existsSync(file)) return 'missing';
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) return 'patched';
  if (src.includes(ANY_MARK)) return 'outdated';
  return 'clean';
}

function writeAtomic(file, text) {
  const tmp = file + '.claude-code-extras-webview.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Write the live settings. Bumps the revision only when the stylesheet actually changed. Returns true if changed. */
function writeLive(claudeExtensionPath, opts = {}) {
  const { css, rev } = liveFiles(claudeExtensionPath);
  if (!fs.existsSync(path.dirname(css))) return false;
  const next = liveCss(opts);
  let current = null;
  try { current = fs.readFileSync(css, 'utf8'); } catch (_) {}
  if (current === next && fs.existsSync(rev)) return false;
  let n = 0;
  try { n = Number((fs.readFileSync(rev, 'utf8').match(/width="(\d+)"/) || [])[1]) || 0; } catch (_) {}
  n = (n % 60000) + 1;
  writeAtomic(css, next);
  // The width carries the revision: the page polls this one-pixel image and reloads the stylesheet when it changes.
  writeAtomic(rev, `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="1"></svg>`);
  return true;
}

/** Apply (or upgrade) the patch and write the live settings. Returns { changed, liveChanged, message }. */
function apply(claudeExtensionPath, opts = {}) {
  const file = webviewFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(claudeExtensionPath);
  if (state === 'missing') return { changed: false, liveChanged: false, message: `Claude Code webview not found at ${file}` };
  let changed = false, message = 'already patched';
  if (state !== 'patched') {
    let original;
    if (state === 'outdated') {
      if (!fs.existsSync(backup)) return { changed: false, liveChanged: false, message: 'an older patch is present but its backup is missing; reinstall Claude Code' };
      original = fs.readFileSync(backup, 'utf8');
    } else {
      original = fs.readFileSync(file, 'utf8');
    }
    const r = patchSource(original);
    if (r.error) return { changed: false, liveChanged: false, message: r.error };
    if (state === 'clean') fs.writeFileSync(backup, original);
    writeAtomic(file, r.out);
    changed = true; message = 'patched';
  }
  const liveChanged = writeLive(claudeExtensionPath, opts);
  return { changed, liveChanged, message };
}

/** Put the original back and remove the backup and the live files. Returns { changed, message }. */
function restore(claudeExtensionPath) {
  const file = webviewFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const { css, rev } = liveFiles(claudeExtensionPath);
  for (const f of [css, rev]) { try { fs.unlinkSync(f); } catch (_) {} }
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  writeAtomic(file, original);
  fs.unlinkSync(backup);
  return { changed: true, message: 'restored' };
}

/** Every Claude Code install under an extensions directory: the active version plus any siblings left behind. */
function findInstalls(extensionsDir) {
  let names = [];
  try { names = fs.readdirSync(extensionsDir); } catch (_) { return []; }
  return names.filter((n) => n.toLowerCase().startsWith('anthropic.claude-code-')).map((n) => path.join(extensionsDir, n));
}

module.exports = {
  id: 'anthropic.claude-code', name: 'Claude Code panel',
  VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS, SCRIPT,
  safeColor, patchSource, status, apply, restore, findInstalls, webviewFile, writeLive, liveCss,
};

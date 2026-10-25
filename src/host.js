// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/**
 * Second patch target: the Claude Code extension host bundle.
 *
 * The host already parses each session's createdAt out of the transcript head, but the object it
 * posts to the webview drops that field, so the session list has no way to show when a session was
 * started. This adapter adds the one field back.
 *
 * Same discipline as the webview patcher: the edit must match exactly once, the result must parse,
 * the untouched original is saved next to the file first, and the replacement is atomic. A build
 * whose shape does not match is left alone with a warning rather than patched on a guess.
 *
 * The host bundle is far riskier to patch than the webview: a broken file means the extension fails
 * to activate. Hence a single, minimal edit and a separate marker and backup, so a failure here
 * cannot disturb the webview patch.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { applyEdits } = require('./edits');

const VERSION = 14;
const MARK = `/* CLAUDE-CODE-EXTRAS-HOST v${VERSION} */`;
const ANY_MARK = '/* CLAUDE-CODE-EXTRAS-HOST v';
const BACKUP_SUFFIX = '.claude-code-extras-host.bak';
const TMP_SUFFIX = '.claude-code-extras-host.tmp';

/* The script that reports a panel whose bundle does not arrive (src/panel-load-watch.js says why it has to be in the
   HTML). It goes into the host bundle as a JSON string, so nothing in it is read as template syntax; the one thing that
   could still break out is the end of a script element. */
const LOAD_WATCH = fs.readFileSync(path.join(__dirname, 'panel-load-watch.js'), 'utf8');
if (/<\/script/i.test(LOAD_WATCH)) throw new Error('panel-load-watch.js must not contain a closing script tag');
/* The one-time clearing of the editor's resource cache (src/panel-cache-clear.js says why). Not behind the recording
   setting: it is what lets a panel that earlier builds left blank come back. */
const CACHE_CLEAR = fs.readFileSync(path.join(__dirname, 'panel-cache-clear.js'), 'utf8');
if (/<\/script/i.test(CACHE_CLEAR)) throw new Error('panel-cache-clear.js must not contain a closing script tag');
/* The panel's time zone, sent to the host so the work plan's tree can show the reader's local time
   (src/panel-tz.js says why). Not behind any setting: without it the tree's times are in the remote machine's zone. */
const PANEL_TZ = fs.readFileSync(path.join(__dirname, 'panel-tz.js'), 'utf8');
if (/<\/script/i.test(PANEL_TZ)) throw new Error('panel-tz.js must not contain a closing script tag');
/* Read by the host at the moment a panel's HTML is built, so the setting reaches every panel opened after it changes.
   Unset counts as on: a panel restored before this extension has activated still gets the watch. */
const LOAD_WATCH_OFF = '__cceNoLoadWatch';

const EDITS = [
  {
    name: 'session list transport',
    re: /return\{id:([\w$]+)\.sessionId,archived:/g,
    to: (m, u) => `return{id:${u}.sessionId,createdAt:${u}.createdAt,archived:`,
  },
  /*
   * Which conversation is in front of the reader.
   *
   * Nothing outside this bundle can answer that. Every conversation opens with one view type and one starting title, so
   * the tabs cannot be told apart by kind, and the lock files name a window's folders but no session. The host does
   * know: it keeps the active session in a field of its own. So the field is what this reads, and it reaches this
   * extension through a global the two share - both run in one extension host process.
   *
   * The field's declaration becomes a pair of accessors, which is one edit that catches every write to it. Hooking a
   * single place that happens to use the value would catch one moment out of eleven, and the moment a conversation is
   * switched to need not be that one.
   *
   * The alternative considered and dropped: read the title off the focused tab and match it against a plan. That joins
   * on text written for people to look at, which drifts, collides between conversations and lags behind a rename, and
   * it needs a fallback for each of those. This is an id or nothing.
   */
  {
    name: 'active conversation id',
    re: /;activeSessionId;/g,
    to: () => ';_cceChat;get activeSessionId(){return this._cceChat}'
      + 'set activeSessionId(v){this._cceChat=v;globalThis.__cceActiveChat=v;'
      + 'try{globalThis.__cceChatHook&&globalThis.__cceChatHook(v)}catch(e){}}',
  },
  /*
   * The panel load watch, in the head just ahead of the panel's stylesheet.
   *
   * Anchored on the stylesheet link and the policy before it, which is where the nonce comes from: the panel's policy
   * runs no script without it. Ahead of the stylesheet because a script after one waits for it, and the stylesheet's
   * request is one of those the watch is there to see stuck.
   */
  {
    name: 'panel load watch',
    re: /(script-src 'nonce-\$\{([\w$]+)\}';[\s\S]{0,600}?)(<link href="\$\{[\w$]+\}" rel="stylesheet">)/g,
    to: (m, before, nonce, link) => before
      + '${\'<script nonce="\'+' + nonce + '+\'">\'+' + JSON.stringify(CACHE_CLEAR) + '+\'</script>\'}'
      + '${\'<script nonce="\'+' + nonce + '+\'">\'+' + JSON.stringify(PANEL_TZ) + '+\'</script>\'}'
      + '${globalThis.' + LOAD_WATCH_OFF + '?"":\'<script nonce="\'+' + nonce + '+\'">\'+'
      + JSON.stringify(LOAD_WATCH) + '+\'</script>\'}'
      + link,
  },
  /*
   * Messages from a panel meant for this extension: the panel's time zone, and a conversation pinned or unpinned in the
   * session list.
   *
   * Every message a panel sends passes through the one function that logs it, before anything decides what the message
   * is, and Claude Code itself ignores both types. A global is how each reaches this extension - both run in one
   * extension host process, the same way the active conversation does.
   */
  {
    name: 'panel messages',
    re: /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{(let [\w$]+=`Received message from webview: )/g,
    to: (m, fn, log, msg, rest) => `function ${fn}(${log},${msg}){try{if(${msg}&&${msg}.type==="cce_client_tz"`
      + `&&typeof ${msg}.timeZone==="string"){globalThis.__cceClientTimeZone=${msg}.timeZone;`
      + `globalThis.__cceTzHook&&globalThis.__cceTzHook(${msg}.timeZone)}`
      + `else if(${msg}&&${msg}.type==="cce_session_pin"&&typeof ${msg}.sessionId==="string"){`
      + `globalThis.__ccePinHook&&globalThis.__ccePinHook(${msg}.sessionId,${msg}.pinned===true)}}catch(e){}${rest}`,
  },
  /*
   * A conversation opened from the session list in the place asked for (src/page/86-open-in-tab-or-sidebar.js). The
   * list's own open request carries where, and the host passes it to the open command in place of the preferred
   * location; a request that does not say is opened as before.
   */
  {
    name: 'session list open says where',
    re: /programmatic:([\w$]+)\.request\.newSessionGroupId&&!\1\.request\.sessionId\?"pin-to-panel":"honor-preferred-location"\}/g,
    to: (m, msg) => `programmatic:${msg}.request.cceWhere==="sidebar"?"cce-pin-to-sidebar":${msg}.request.cceWhere==="tab"?"pin-to-panel":`
      + `${msg}.request.newSessionGroupId&&!${msg}.request.sessionId?"pin-to-panel":"honor-preferred-location"}`,
  },
  /*
   * Opening one is decided in one function: a programmatic open goes to the sidebar only when the preferred location is
   * the sidebar, and otherwise to a tab. One more request value sends it to the sidebar whatever that setting says,
   * unless the conversation is already open in a tab, where it is shown. The setting is not touched, as with the
   * official programmatic opens.
   */
  {
    name: 'open in the sidebar on request',
    re: /if\(([\w$]+)\)return\{target:\1==="honor-preferred-location"&&([\w$]+)==="sidebar"&&!([\w$]+)\?"sidebar":"panel",/g,
    to: (m, how, where, open) => `if(${how})return{target:(${how}==="cce-pin-to-sidebar"||${how}==="honor-preferred-location"&&${where}==="sidebar")&&!${open}?"sidebar":"panel",`,
  },
  /*
   * Whether the sidebar's conversation can be seen, sent with the open conversations to every panel. A hidden sidebar
   * keeps its conversation loaded, so the host still lists it among the sidebar's; OPEN SESSIONS leaves it out while the
   * sidebar is hidden (src/page/84-open-sessions.js). The state goes out with every update of the open conversations,
   * and the sidebar showing or hiding sends one.
   */
  {
    name: 'session states say whether the sidebar is shown',
    re: /for\(let ([\w$]+) of this\.allComms\)\1\.sendSessionStates\(([^;]*?),\1===([\w$]+)\?void 0:([\w$]+)\)/g,
    to: (m, c, args, side, ids) => `for(let ${c} of this.allComms)${c}.sendSessionStates(${args},${c}===${side}?void 0:${ids},`
      + `${side}!==void 0&&[...this.webviews].some((cceV)=>cceV.comms===${side}&&cceV.isVisible()))`,
  },
  {
    name: 'session states message carries whether the sidebar is shown',
    re: /sendSessionStates\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\{type:"request",channelId:"",requestId:([\w$]+)\(\),request:\{type:"session_states_update",([^{}]*?),sidebarSessionIds:\6\}\}/g,
    to: (m, a, b, c, d, e, f, z, id, fields) => `sendSessionStates(${a},${b},${c},${d},${e},${f},cceShown){let ${z}={type:"request",channelId:"",`
      + `requestId:${id}(),request:{type:"session_states_update",${fields},sidebarSessionIds:${f},cceSidebarShown:cceShown}}`,
  },
  {
    name: 'sidebar showing or hiding updates the open conversations',
    re: /onDidChangeVisibility\(\(\)=>\{([\w$]+)\.notifyVisibilityChange\(([\w$]+)\.visible\),this\.updateSidebarActiveState\(\)\}/g,
    to: (m, comms, view) => `onDidChangeVisibility(()=>{${comms}.notifyVisibilityChange(${view}.visible),this.updateSidebarActiveState(),this.broadcastSessionStates()}`,
  },
  /*
   * The dot after a tab's title (src/tabdot.js says what it is for).
   *
   * The host picks a tab's icon in one method, each time the state behind it can change, and that state is all the dot
   * needs. So the method hands it over right after setting the icon, through a global this extension shares with the
   * host - both run in one extension host process, the same way the active conversation and the time zone do.
   */
  {
    name: 'tab dot',
    re: /(this\.panelTab\.iconPath=[\w$]+\.Uri\.file\([\w$]+\.join\(this\.context\.extensionPath,"resources",[\w$]+\[([\w$]+)\]\)\))\}/g,
    to: (m, set, state) => `${set};try{globalThis.__cceTabDot&&globalThis.__cceTabDot(this.panelTab,${state})}catch(e){}}`,
  },
  /*
   * Pinned conversations are not archived for being inactive (src/sessionpins.js says how they are pinned).
   *
   * The automatic archive skips every session it counts as in use, and a session in a group of the list is one of them.
   * Pinned ones join that same set, so they are skipped for the same reason and by the same test; the ids come from this
   * extension through a global, read each time the set is built. Anything going wrong there leaves the set as it was.
   */
  {
    name: 'pinned conversations not archived',
    re: /groupedSessionKeys:new Set\(([\w$.]+\.getSessionGroups\(\)\.flatMap\(\(([\w$]+)\)=>\2\.sessionIds\))\)/g,
    to: (m, groups) => `groupedSessionKeys:new Set([...${groups},...(()=>{try{let p=globalThis.__ccePinnedIds,`
      + 'r=typeof p==="function"?p():[];return Array.isArray(r)?r.filter((x)=>typeof x==="string"):[]}catch(e){return[]}})()])',
  },
];

function hostFile(claudeExtensionPath) { return path.join(claudeExtensionPath, 'extension.js'); }

/** Pure transform. Returns { out, chosen } or { error }. Never partially applies. */
function patchSource(src) {
  if (src.includes(ANY_MARK)) return { error: 'already patched' };
  const r = applyEdits(src, EDITS);
  if (r.error) return { error: r.error };
  const out = MARK + '\n' + r.out;
  try { new vm.Script(out, { filename: 'extension.js' }); }
  catch (err) { return { error: `patched host code does not parse: ${err.message}` }; }
  return { out, chosen: r.chosen };
}

/** 'patched' (this version), 'outdated' (another version of this patch), 'clean', 'missing'. */
function status(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  if (!fs.existsSync(file)) return 'missing';
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) return 'patched';
  if (src.includes(ANY_MARK)) return 'outdated';
  return 'clean';
}

function writeAtomic(file, text) {
  const tmp = file + TMP_SUFFIX;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Apply (or upgrade) the host patch. Returns { changed, liveChanged, message }. */
function apply(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  const state = status(claudeExtensionPath);
  if (state === 'missing') return { changed: false, liveChanged: false, message: `Claude Code host bundle not found at ${file}` };
  if (state === 'patched') return { changed: false, liveChanged: false, message: 'already patched' };
  let original;
  if (state === 'outdated') {
    if (!fs.existsSync(backup)) return { changed: false, liveChanged: false, message: 'an older host patch is present but its backup is missing; reinstall Claude Code' };
    original = fs.readFileSync(backup, 'utf8');
  } else {
    original = fs.readFileSync(file, 'utf8');
  }
  const r = patchSource(original);
  if (r.error) return { changed: false, liveChanged: false, message: r.error };
  if (state === 'clean') fs.writeFileSync(backup, original);
  writeAtomic(file, r.out);
  return { changed: true, liveChanged: false, message: 'patched' };
}

/** Put the original host bundle back and remove the backup. Returns { changed, message }. */
function restore(claudeExtensionPath) {
  const file = hostFile(claudeExtensionPath);
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { changed: false, message: 'nothing to restore' };
  const original = fs.readFileSync(backup, 'utf8');
  if (original.includes(ANY_MARK)) return { changed: false, message: 'backup is itself patched; not restored' };
  writeAtomic(file, original);
  fs.unlinkSync(backup);
  return { changed: true, message: 'restored' };
}

module.exports = {
  id: 'anthropic.claude-code', name: 'Claude Code host',
  VERSION, MARK, ANY_MARK, BACKUP_SUFFIX, EDITS, LOAD_WATCH, LOAD_WATCH_OFF, CACHE_CLEAR, PANEL_TZ,
  patchSource, status, apply, restore, hostFile, targetFile: hostFile,
  findInstalls: require('./webview').findInstalls,
};

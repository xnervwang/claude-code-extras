// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Work Plan for Claude Code — user interface additions for the Claude Code panel in VS Code.
 *
 * This extension owns no user interface of its own. It patches the Claude Code extension's own files at rest, one
 * adapter per target file (see src/adapters.js), and every write is guarded the same way: match the expected code
 * shape exactly once or write nothing, keep the untouched original beside the file, replace atomically, and put the
 * original back on Remove or uninstall. A Claude Code build whose shape does not match is reported and left alone.
 *
 * Because the patch lives in files the editor has already loaded, installing or upgrading it asks for one reload.
 * After that, turning the marks off and changing the message color take effect live, through the stylesheet written
 * next to the panel (see src/live.js).
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const webview = require('./src/webview');
const host = require('./src/host');
const { safeColor } = webview;
const { readTasks } = require('./src/tasks');
const background = require('./src/background');
const efforts = require('./src/efforts');
const { countOpen, sweepOrphans, liveSessions, planDir, DATA_ROOT, PLAN_DIR } = require('./src/workplan');
const { WorkPlanProvider } = require('./src/workplan-view');
const pluginInstall = require('./src/plugin-install');
const latency = require('./src/openlatency');
const tabdot = require('./src/tabdot');
const sessionPins = require('./src/sessionpins');
const droppedTabs = require('./src/droppedtabs');
const deleteSession = require('./src/deletesession');
const recentClosed = require('./src/recentclosed');
const ADAPTERS = require('./src/adapters');
const removal = require('./src/removal');
const PACKAGE = require('./package.json');

/* <publisher>.<name>, which is also how the editor names this extension's folders. Read from the manifest rather than
   from the editor's API because deactivate needs it, and by then that API is gone. */
const ID = PACKAGE.publisher + '.' + PACKAGE.name;
/* Where this copy is installed, kept for deactivate for the same reason. */
let selfPath = '';

/* Settings and commands are named under this prefix. The keys this extension keeps in its own state are not settings,
   are not seen by anyone, and keep the names they were first stored under. */
const PREFIX = 'claudeCodeWorkPlan.';
const LEGACY_PREFIX = 'claudeCodeExtras.';
const SETTING = PREFIX + 'enabled';
const COLOR_SETTING = PREFIX + 'userMessageColor';
const EDGE_SETTING = PREFIX + 'userMessageEdge';
const REMOVED_KEY = 'claudeCodeExtras.removed';
const PLUGIN_KEY = 'claudeCodeExtras.workPlanPlugin';
const SWEEP_KEY = 'claudeCodeExtras.lastOrphanSweep';
const LATENCY_KEY = 'claudeCodeExtras.latencyOffset';
const THRESHOLD_SETTING = PREFIX + 'latencyThresholdSeconds';
const LATENCY_ON_SETTING = PREFIX + 'recordOpenLatency';
const PINS_SETTING = PREFIX + 'sessionPins';
const PIN_MARGIN_SETTING = PREFIX + 'sessionPinsMarginDays';
const REOPEN_SETTING = PREFIX + 'reopenDroppedTabs';
const RECENT_SETTING = PREFIX + 'recentClosedSessions';
/* Read by the plugin's hooks, which are separate processes and cannot see editor settings. Keys match plan_path.py. */
const HOOK_SETTINGS = {
  enabled: PREFIX + 'workPlan',
  offerMinTurns: PREFIX + 'workPlanOfferMinTurns',
  offerMinToolCalls: PREFIX + 'workPlanOfferMinToolCalls',
  quietWhenReplyMatches: PREFIX + 'workPlanQuietWhenReplyMatches',
  tellTimeZone: PREFIX + 'tellClaudeYourTimeZone',
};

/** Every install of Claude Code this adapter can see: the active one plus sibling versions in the same folder. */
function installs(adapter) {
  const ext = vscode.extensions.getExtension(adapter.id);
  if (!ext) return [];
  return Array.from(new Set([ext.extensionPath, ...adapter.findInstalls(path.dirname(ext.extensionPath))]));
}

const cfg = () => vscode.workspace.getConfiguration();
function enabled() { return cfg().get(SETTING, true); }

/** Folders this window has open, which is where a session started here keeps its scheduled-prompt file. */
function openDirs() {
  return (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri && f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}

async function offerReload(text) {
  const pick = await vscode.window.showInformationMessage(text, 'Reload Window');
  if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/* Commands were once named under the old prefix, and a keybinding someone made then still names them that way. The old
   names stay registered, unlisted, so those keep working. */
function registerCommand(name, fn) {
  const current = vscode.commands.registerCommand(PREFIX + name, fn);
  const legacy = vscode.commands.registerCommand(LEGACY_PREFIX + name, fn);
  return { dispose() { current.dispose(); legacy.dispose(); } };
}

/*
 * Settings were once named under the old prefix. A value set under an old name is copied to its new name, in the same
 * scope, and the old one is then cleared where the editor allows that - it may refuse to write a name no extension
 * declares any more, and then the old line stays behind, read by nothing.
 *
 * A copy is made only where the new name has no value of its own, so nothing set under the new name is overwritten; and
 * each scope is done once, so putting a new name back to its default later does not bring the old value back.
 */
const RENAMED_KEY = LEGACY_PREFIX + 'settingsRenamed';
async function renameSettings(context) {
  const contrib = (context.extension.packageJSON.contributes || {}).configuration || {};
  const names = [].concat(contrib).flatMap((c) => Object.keys((c && c.properties) || {}))
    .filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
  const T = vscode.ConfigurationTarget;
  const groups = [];
  const all = () => vscode.workspace.getConfiguration();
  if (!context.globalState.get(RENAMED_KEY)) {
    groups.push({ state: context.globalState,
      scopes: [{ where: 'user', target: T.Global, field: 'globalValue', conf: all }] });
  }
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length && !context.workspaceState.get(RENAMED_KEY)) {
    const inFolder = (f) => ({ where: 'folder ' + f.name, target: T.WorkspaceFolder, field: 'workspaceFolderValue',
      conf: () => vscode.workspace.getConfiguration(undefined, f.uri) });
    groups.push({ state: context.workspaceState,
      scopes: [{ where: 'workspace', target: T.Workspace, field: 'workspaceValue', conf: all }].concat(folders.map(inFolder)) });
  }
  const done = [];
  for (const g of groups) {
    let complete = true;
    for (const sc of g.scopes) {
      const conf = sc.conf();
      let moved = 0, left = 0;
      for (const name of names) {
        const old = conf.inspect(LEGACY_PREFIX + name);
        const value = old ? old[sc.field] : undefined;
        if (value === undefined) continue;
        const now = conf.inspect(PREFIX + name);
        try {
          if (!now || now[sc.field] === undefined) await conf.update(PREFIX + name, value, sc.target);
          moved++;
        } catch (_) { complete = false; continue; }
        try { await conf.update(LEGACY_PREFIX + name, undefined, sc.target); } catch (_) { left++; }
      }
      if (moved) done.push(`${moved} in ${sc.where}` + (left ? ` (${left} old line${left > 1 ? 's' : ''} left in place)` : ''));
    }
    if (complete) await g.state.update(RENAMED_KEY, true);
  }
  return done.join(', ');
}

async function activate(context) {
  let renamed = '';
  try { renamed = await renameSettings(context); } catch (e) { renamed = 'failed: ' + (e && e.message); }
  return start(context, renamed);
}

function start(context, renamed) {
  const log = vscode.window.createOutputChannel('Work Plan for Claude Code');
  context.subscriptions.push(log);
  if (renamed) log.appendLine(`settings moved from ${LEGACY_PREFIX}* to ${PREFIX}*: ${renamed}`);
  const removed = () => context.globalState.get(REMOVED_KEY, false) === true;
  selfPath = context.extensionPath;
  /* True once the editor has marked this copy for deletion with no other version staying - an uninstall that is waiting
     for this window to restart its extensions. Until then this window must not patch what another window restored on
     its way out (see src/removal.js). */
  const uninstalling = () => removal.beingUninstalled(context.extensionPath, ID);
  /* True once this copy has been installed again over itself while this window kept running the earlier build. That
     window then leaves every shared file alone; the windows that reload run the new build and keep them current. */
  const loadedStamp = removal.installStamp(context.extensionPath);
  const replaced = () => removal.replacedSince(context.extensionPath, loadedStamp);

  /*
   * Which project directories to look for scheduled prompts in - remembered across windows, not taken from this one.
   *
   * The stylesheet the page reads sits in Claude Code's own folder, so every window writes the SAME file. If each wrote
   * only what its own open folders yielded, two windows would take turns adding and removing the section every refresh.
   * Remembering the union makes every window write the same content, so whoever writes last changes nothing.
   *
   * Directories that no longer exist are dropped, and the list is capped, so a machine that has opened hundreds of
   * projects over a year does not turn one refresh into hundreds of reads.
   *
   * The known gap: a session started in a SUBdirectory of an open folder is not found, and its section simply does not
   * appear. Walking directories would trade a certain cost for an uncertain gain, so it waits for a real case.
   */
  const DIRS_KEY = 'claudeCodeExtras.projectDirs';
  const MAX_DIRS = 30;
  function knownDirs() {
    const remembered = context.globalState.get(DIRS_KEY, []);
    const merged = [...openDirs(), ...(Array.isArray(remembered) ? remembered : [])]
      .filter((d) => typeof d === 'string' && d);
    const kept = [];
    for (const d of merged) {
      if (kept.includes(d)) continue;
      try { if (!fs.statSync(d).isDirectory()) continue; } catch (_) { continue; }
      kept.push(d);
      if (kept.length >= MAX_DIRS) break;
    }
    // Most recently opened first, so the cap drops the oldest rather than whatever happened to be listed last.
    if (kept.join('\u0000') !== (Array.isArray(remembered) ? remembered : []).join('\u0000')) {
      context.globalState.update(DIRS_KEY, kept);
    }
    return kept;
  }

  /* One setting per switchable addition, named after it. Reading them here rather than in src/webview.js keeps that
     file free of the editor's API, which is what lets the tests run it. */
  const switchedOff = () => webview.SWITCHES.filter((k) => cfg().get(PREFIX + 'show.' + k, true) === false);
  /* The conversations pinned in the session list (src/sessionpins.js). The file is in this extension's storage on the
     machine that holds the transcripts, and every window reads and writes the same one. */
  const pinsFile = () => path.join(context.globalStorageUri.fsPath, sessionPins.FILE);
  const pinsOn = () => !removed() && cfg().get(PINS_SETTING, true) !== false;
  const pinMargin = () => cfg().get(PIN_MARGIN_SETTING, sessionPins.MARGIN_DAYS);
  const options = () => {
    const off = switchedOff();
    return {
      enabled: enabled(), userColor: cfg().get(COLOR_SETTING, ''), userEdge: cfg().get(EDGE_SETTING, true) !== false,
      off,
      tasks: readTasks(knownDirs()),
      background: off.includes('backgroundSessions') ? [] : background.collect(),
      pins: pinsOn() ? sessionPins.pageData(sessionPins.read(pinsFile()), sessionPins.retentionDays(), pinMargin()) : null,
    };
  };
  const writeLiveNow = () => {
    if (uninstalling() || replaced()) return;
    try {
      const opts = options();
      for (const dir of installs(webview)) webview.writeLive(dir, opts);
    } catch (e) {
      log.appendLine('live refresh failed: ' + e.message);
    }
  };
  /* Reads what the conversation in front of the reader has added to its transcript since last time - the only one, since
     that is the one being looked at; the others were read when they were. A new session is written out at once rather
     than at the next refresh, so it appears in the agent map while the launch is still on screen. */
  /* Where each reply's effort changed, for the conversation in front of the reader, written beside the panel for it to
     read (src/efforts.js). Not read at all when the model is switched off, since the effort is shown with it. */
  const scanEffort = (opts) => {
    if (removed() || !enabled() || uninstalling() || replaced() || switchedOff().includes('modelName')) return;
    const id = activeChat();
    if (!id) return;
    efforts.scan(id, opts || {})
      .then((r) => { if (r && r.css) for (const dir of installs(webview)) webview.writeEffort(dir, id, r.css); })
      .catch((e) => log.appendLine('reply efforts: ' + e.message));
  };
  const scanBackground = () => {
    if (removed() || !enabled() || switchedOff().includes('backgroundSessions')) return;
    const id = activeChat();
    if (!id) return;
    background.scan(id)
      .then((r) => { if (r && r.added) writeLiveNow(); })
      .catch((e) => log.appendLine('background sessions: ' + e.message));
  };

  /* Bring every install in line with the current settings. Only installing, upgrading or removing the patch itself
     asks for a reload; on and off and the color are picked up by an open panel within a couple of seconds. */
  async function sync({ interactive = false } = {}) {
    if (replaced()) {
      log.appendLine('sync: this window runs a build that has since been installed again; leaving the files to the windows running it');
      if (interactive) offerReload('This window is running an earlier build of Work Plan for Claude Code than the one now installed. Reload the window to run it.');
      return;
    }
    const patched = [], restored = [], problems = [];
    const leaving = uninstalling();
    let found = 0;
    for (const adapter of ADAPTERS) {
      for (const dir of installs(adapter)) {
        found++;
        const label = `${adapter.name} (${path.basename(dir)})`;
        try {
          if (removed() || leaving) {
            const r = adapter.restore(dir);
            log.appendLine(`${label}: ${r.message}`);
            if (r.changed && !restored.includes(adapter.name)) restored.push(adapter.name);
          } else {
            const r = adapter.apply(dir, options());
            log.appendLine(`${label}: ${r.message}${r.liveChanged ? ' (live settings updated)' : ''}`);
            if (r.changed && !patched.includes(adapter.name)) patched.push(adapter.name);
            else if (!r.changed && r.message !== 'already patched') problems.push(`${label}: ${r.message}`);
          }
        } catch (e) {
          problems.push(`${label}: ${e.message}`);
          log.appendLine(`${label}: error ${e.stack || e.message}`);
        }
      }
    }
    if (!found && interactive) vscode.window.showWarningMessage('Work Plan for Claude Code: the Claude Code extension is not installed, so there is nothing to patch.');
    // A shape mismatch after a Claude Code update would otherwise be silent, so it is said out loud.
    if (problems.length) vscode.window.showWarningMessage('Work Plan for Claude Code: ' + problems.join(' | '));
    if (patched.length) offerReload(`Work Plan for Claude Code is installed in ${patched.join(' and ')}. Reload the window once to start; after that, On/Off and colors change live.`);
    // An uninstall already has the editor asking for a restart of its extensions; a second prompt would only compete.
    if (restored.length && !leaving) offerReload(`Work Plan for Claude Code was removed from ${restored.join(' and ')}. Reload the window to finish.`);
  }

  /* No status bar item for on and off.
   *
   * There was one, reading "Extras: On". It promised more than the setting behind it does: off stops the additions being
   * drawn, while the patch, the injected script, its poll and the hooks all stay - so a reader took it for a switch that
   * turns this extension off, which is the Remove command. It also sat one click away in the left status bar, where
   * hitting it by accident silently changed a global setting. The three commands remain for anyone who wants it.
   */
  const setEnabled = async (value) => {
    if (value && removed()) await context.globalState.update(REMOVED_KEY, false);
    if (enabled() === value) { await sync({ interactive: true }); return; }
    await cfg().update(SETTING, value, vscode.ConfigurationTarget.Global);
  };

  context.subscriptions.push(
    registerCommand('enable', () => setEnabled(true)),
    registerCommand('disable', () => setEnabled(false)),
    registerCommand('toggle', () => setEnabled(!(enabled() && !removed()))),
    registerCommand('remove', async () => {
      await context.globalState.update(REMOVED_KEY, true);
      await sync({ interactive: true });
    }),
    registerCommand('status', () => {
      const lines = [];
      for (const adapter of ADAPTERS) for (const d of installs(adapter)) lines.push(`${adapter.name} ${path.basename(d)}: ${adapter.status(d)}`);
      vscode.window.showInformationMessage('Work Plan for Claude Code — ' + (lines.join(' | ') || 'Claude Code is not installed') + (removed() ? ' (removed)' : ''));
    }),
    /* Every setting this extension has, in the editor's own settings UI: search, per-workspace values, sync and a JSON
       view come with it, and none of it is ours to maintain. */
    /*
     * Take the plugin out of Claude Code's own settings, which is the only way to stop its skill description being
     * loaded - about a hundred tokens a session that the switch above cannot reach, because the switch only tells the
     * plugin's hooks to do nothing while the plugin itself stays registered.
     *
     * A command rather than something the switch does, because this writes Claude Code's configuration rather than ours,
     * and an extension that quietly edits another tool's settings is the behaviour nobody wants to discover later.
     * `disable` and not `uninstall`: uninstalling takes the plugin's data directory with it, and that is where every
     * conversation's plan lives.
     */
    registerCommand('disableWorkPlanPlugin', async () => {
      const yes = await vscode.window.showWarningMessage(
        'Stop Claude Code loading the work plan plugin? This edits Claude Code\'s own settings, and saves the skill '
        + 'description it loads every session. Your existing plans are left alone.',
        { modal: true }, 'Stop loading it');
      if (yes !== 'Stop loading it') return;
      const r = await pluginInstall.disable();
      log.appendLine('work plan plugin: ' + r.said);
      log.show(true);
      if (r.ok) await offerReload('The work plan plugin will stop loading in conversations started after a reload.');
    }),
    registerCommand('openSettings',
      // Our own id, so a change of publisher or name cannot leave this pointing at an extension that is not here.
      () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id)),
    /* Reads the records rather than measuring anything, so it is also the way to see them after a window restart. */
    registerCommand('showOpenLatency', () => {
      sampleLatency();
      /* Every window's records, not just this one's - a regression shows up across windows, and the window you happen to
         run this from is rarely the one that was slow. */
      const records = latency.readAll(latencyDir());
      log.appendLine('');
      for (const line of latency.report(records, thresholdMs())) log.appendLine(line);
      log.appendLine(`  records: ${path.join(latencyDir(), 'open-latency-<pid>.jsonl')}, one per window`);
      log.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (Object.values(HOOK_SETTINGS).some((k) => e.affectsConfiguration(k))) writeHookSettings();
      /* A switch has to reach the panel the moment it is flipped, which is what writing the stylesheet does. */
      const touched = [SETTING, COLOR_SETTING, EDGE_SETTING, PINS_SETTING, PIN_MARGIN_SETTING]
        .concat(webview.SWITCHES.map((k) => PREFIX + 'show.' + k));
      if (!touched.some((k) => e.affectsConfiguration(k))) return;
      const c = cfg().get(COLOR_SETTING, '');
      if (c && !safeColor(c)) vscode.window.showWarningMessage(`Work Plan for Claude Code: "${c}" is not a CSS color (use e.g. #90EE90, lightgreen or rgb(144,238,144)); your message color is left unchanged.`);
      sync();
    }),
    // A Claude Code update arrives as a new folder, so patch it as soon as that folder appears.
    vscode.extensions.onDidChange(() => sync()),
  );

  /* A task file is written by another process, so nothing in this extension would otherwise notice it change and the
     panel would keep showing the reading from startup. Only the live settings are rewritten here - a full sync re-reads
     a five-megabyte bundle to check its state - and the write bumps the page's revision only when the content differs,
     so a quiet machine costs one small read per folder and nothing else. */
  const REFRESH_MS = 30000;
  const refresh = setInterval(() => {
    if (removed() || !enabled() || uninstalling() || replaced()) return;
    scanBackground();
    scanEffort();
    watchEffort();
    writeLiveNow();
    sampleLatency();
  }, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(refresh) });

  /*
   * How long this window makes you wait, taken from the official extension's log rather than measured here - see
   * src/openlatency.js for what is paired with what. It rides the timer above because it costs one stat of one file
   * when nothing has been written, and reads only the bytes appended since the last pass.
   *
   * It is deliberately not in the injected script. A readout added there once made reloading the window crash, and the
   * mechanism was never established; the panel is also the wrong side to measure from, since what is being timed is a
   * panel that has not started yet.
   */
  /* A directory rather than a file: each window writes only its own, since several of them share this folder and
     nothing locks it. src/openlatency.js says what goes wrong when they share one. */
  const latencyDir = () => context.globalStorageUri.fsPath;
  const stamp = () => {
    const ours = context.extension && context.extension.packageJSON && context.extension.packageJSON.version;
    const ext = vscode.extensions.getExtension(webview.id);
    const theirs = ext && ext.packageJSON && ext.packageJSON.version;
    return `${ours || '?'}/${theirs || '?'}`;
  };
  const thresholdMs = () => Math.max(1, cfg().get(THRESHOLD_SETTING, 10)) * 1000;
  /* How far this window's log has been read, the pairings still open in it, and the running count of fast opens, all in
     memory. Each window writes a log of its own and a reload starts a new one, so none of it means anything to another
     window or survives a reload; kept in the store every window shares, it was carried into the wrong log and paired
     lines that had nothing to do with each other. */
  let latencyState = {};
  if (context.globalState.get(LATENCY_KEY) !== undefined) context.globalState.update(LATENCY_KEY, undefined);
  function sampleLatency() {
    /* Off means nothing is read either. Stopping only the writing would leave the log being opened and parsed every
       thirty seconds, which is most of what this costs. */
    if (!cfg().get(LATENCY_ON_SETTING, true)) return;
    try {
      const r = latency.sample({
        log: latency.logFile(context.logUri.fsPath),
        dir: latencyDir(),
        state: latencyState,
        version: stamp(),
        thresholdMs: thresholdMs(),
      });
      if (r.state) latencyState = r.state;
      /* Anything recorded is already past the threshold, so it is worth saying without being asked. */
      for (const w of r.added) {
        log.appendLine(`waited ${(w.waited / 1000).toFixed(1)}s for ${w.what} (${w.trigger}) at ${w.at}`);
      }
    } catch (e) {
      log.appendLine('open latency: ' + e.message);
    }
  }
  sampleLatency();

  /* The other half of the same recording runs in the panel itself (src/panel-load-watch.js), put there by the patched
     host bundle as each panel's HTML is built. That bundle runs in this process and reads this flag at that moment, so
     the setting reaches the next panel opened without a reload. */
  const loadWatchOff = () => { globalThis[host.LOAD_WATCH_OFF] = !cfg().get(LATENCY_ON_SETTING, true); };
  loadWatchOff();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(LATENCY_ON_SETTING)) loadWatchOff(); }),
    { dispose: () => { delete globalThis[host.LOAD_WATCH_OFF]; } },
  );

  /*
   * Hand the hooks their thresholds.
   *
   * They run as their own processes, so the editor's settings cannot reach them directly; this is the one file they read
   * instead, which keeps the settings UI as the only place a person edits these. Written on activation and whenever one
   * of them changes, and never required to exist - the plugin ships its own defaults so it works without this extension.
   */
  function writeHookSettings() {
    const values = {};
    for (const [key, setting] of Object.entries(HOOK_SETTINGS)) {
      const v = cfg().get(setting);
      if (typeof v === 'boolean') values[key] = v;
      else if (typeof v === 'number' && v >= 1) values[key] = Math.floor(v);
      else if (typeof v === 'string' && v) values[key] = v;
    }
    /* planDir(), not PLAN_DIR: that one is only the directory's name, and joined on its own it resolves against the
       extension host's working directory - a config.json the hooks never read. */
    const dir = planDir();
    const file = path.join(dir, 'config.json');
    const next = JSON.stringify(values, null, 2) + '\n';
    try {
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch (_) {}
      /* Several windows write this, and they all write the same thing from the same settings - so comparing first keeps
         them from taking turns rewriting one file, the way the live stylesheet already does. */
      if (current === next) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, next);
    } catch (e) {
      log.appendLine('work plan hook settings: ' + e.message);
    }
  }
  writeHookSettings();

  /* The day's count is written out when the window closes, which is the other moment it is known to be complete. */
  context.subscriptions.push({
    dispose: () => {
      try { latency.flush({ dir: latencyDir(), state: latencyState }); } catch (_) { /* closing anyway */ }
    },
  });

  /*
   * The work plan view. This is the one part of the extension that is its own user interface rather than an addition to
   * Claude Code's panel, and it is deliberately outside that panel: a panel webview belongs to Claude Code, has no file
   * system of its own and refuses a fetch, so anything shown in there has to be smuggled through a file it already
   * loads. Owning the view instead means reading the file with no trick at all.
   *
   * Nothing here writes a work plan. The extension shows what a conversation keeps, and offers the file for editing so
   * a correction goes into the same copy the conversation reads back.
   */
  const workplan = new WorkPlanProvider();
  const view = vscode.window.createTreeView('claudeCodeExtras.workPlan', { treeDataProvider: workplan });
  context.subscriptions.push(view);

  /* The badge is the whole point of a glance: it says how much is waiting without anything being opened, and it is
     absent rather than zero when nothing is, so an idle machine grows no ornament. */
  const paintBadge = () => {
    /* Counted over what the view is showing, not over the machine. A count that includes conversations the tree does not
       show says a number the reader cannot find, which reads as the tree being broken rather than the count being wider. */
    const plans = workplan.shown();
    let open = 0;
    for (const plan of plans) {
      const n = countOpen(plan.nodes);
      open += (n.todo || 0) + (n.discussing || 0);
    }
    const where = plans.length === 1 ? 'in this conversation' : `across ${plans.length} conversation(s)`;
    view.badge = open ? { value: open, tooltip: `${open} still open ${where}` } : undefined;
  };
  /* The id of the conversation in front of the reader, or empty. The patched field writes it on every change; before
     anything has, or when the panel has no conversation open, it is not a string and reads as empty - the view shows
     its welcome text there rather than another conversation's plan. */
  const activeChat = () => {
    const v = globalThis.__cceActiveChat;
    return typeof v === 'string' ? v : '';
  };
  /*
   * Delete the plans of conversations that no longer exist, at most once a calendar day.
   *
   * There is no timer for this, deliberately. It is reached from activation and from the periodic refresh below noticing
   * that the day has changed - so opening a window is what triggers it, and a window left open for weeks still gets a
   * turn. On every other call the whole cost is one string compare.
   *
   * The day is recorded before the work, not after: several windows are separate extension hosts sharing one unlocked
   * directory, and a reading that keeps failing should not be retried twice a minute until midnight.
   */
  const sweepPlans = async () => {
    if (removed()) return;
    const day = new Date().toISOString().slice(0, 10);
    if (context.globalState.get(SWEEP_KEY, '') === day) return;
    await context.globalState.update(SWEEP_KEY, day);
    const r = sweepOrphans();
    if (r.why) log.appendLine('orphan work plans: ' + r.why);
    else if (r.deleted) log.appendLine(`orphan work plans: deleted ${r.deleted}, kept ${r.kept}`);
    // The efforts written beside the panel go with the conversation; an unreadable list of them removes nothing.
    const live = liveSessions();
    if (live) for (const dir of installs(webview)) webview.pruneEfforts(dir, live);
  };
  /* The reader's time zone as a panel of this window last reported it (src/panel-tz.js), or empty until one has. */
  const clientZone = () => {
    const v = globalThis.__cceClientTimeZone;
    return typeof v === 'string' ? v : '';
  };
  /* The plugin's hooks tell the model this zone (tell-time-zone.py), and they run beside Claude Code with no way to ask
     a panel, so it is left for them in a file. The last panel to report wins: one person behind several windows reads
     them all in one zone. A window that has not heard from a panel yet writes nothing rather than an empty zone. */
  const writeClientZone = () => {
    const zone = clientZone();
    if (!zone) return;
    const file = path.join(planDir(), 'client-time-zone.json');
    const next = JSON.stringify({ timeZone: zone }) + '\n';
    try {
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch (_) {}
      if (current === next) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
    } catch (e) {
      log.appendLine('client time zone: ' + e.message);
    }
  };
  const refreshPlans = () => {
    sweepPlans().catch((e) => log.appendLine('orphan work plans: ' + e.message));
    workplan.setTimeZone(clientZone());
    const moved = workplan.setFocus(activeChat());
    if (workplan.refresh() || moved) paintBadge();
  };
  /*
   * Following the conversation has to be immediate, so the patched field calls this the moment it is written. Waiting
   * for the periodic scan meant up to half a minute of showing the conversation you just left, which is not "follows
   * the conversation" - it is the same complaint with a delay.
   *
   * The fast tick beside it reads one property and nothing else. It is there because the callback depends on the host
   * patch being in, and a build whose shape did not match would otherwise leave the view frozen with no sign why.
   */
  /*
   * The transcripts of the conversation in front of the reader are watched, so a reply's effort is read within a second
   * of the reply being written rather than at the next thirty-second refresh - which is when the reader is looking at
   * it. A turn appends a row per block in a burst, so a change is scanned after a short pause and one pass reads the
   * burst. Nothing runs while nothing is written. The refresh still scans, and re-establishes a watch that has failed
   * or a sub-agents folder that did not exist yet.
   */
  const EFFORT_SETTLE_MS = 700;
  let effortWatch = { id: '', main: null, sub: null, timer: 0, subs: false };
  const unwatchEffort = () => {
    for (const w of [effortWatch.main, effortWatch.sub]) { if (w) { try { w.close(); } catch (_) { /* closed */ } } }
    if (effortWatch.timer) clearTimeout(effortWatch.timer);
    effortWatch = { id: '', main: null, sub: null, timer: 0, subs: false };
  };
  const watchEffort = () => {
    const id = activeChat();
    if (id !== effortWatch.id) unwatchEffort();
    if (!id || removed() || !enabled() || replaced() || switchedOff().includes('modelName')) { unwatchEffort(); return; }
    const transcript = background.transcriptOf(id);
    if (!transcript) return;
    effortWatch.id = id;
    /* Only the side that changed is read: the sub-agents are looked at when their folder changed, not on every row the
       conversation itself appends. */
    const soon = (slot) => () => {
      if (slot === 'sub') effortWatch.subs = true;
      if (effortWatch.timer) return;
      effortWatch.timer = setTimeout(() => {
        const subs = effortWatch.subs;
        effortWatch.timer = 0;
        effortWatch.subs = false;
        scanEffort({ subagents: subs });
      }, EFFORT_SETTLE_MS);
    };
    const open = (target, slot) => {
      if (effortWatch[slot]) return;
      try {
        const w = fs.watch(target, { persistent: false }, soon(slot));
        w.on('error', () => { try { w.close(); } catch (_) { /* closed */ } if (effortWatch[slot] === w) effortWatch[slot] = null; });
        effortWatch[slot] = w;
      } catch (_) { /* not there yet: the refresh tries again */ }
    };
    open(transcript, 'main');
    open(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents'), 'sub');
  };
  context.subscriptions.push({ dispose: unwatchEffort });
  const followChat = () => {
    const id = activeChat();
    if (!workplan.setFocus(id)) return;
    log.appendLine('active conversation: ' + (id || '(none reported)'));
    workplan.refresh();
    paintBadge();
    scanBackground();
    scanEffort();
    watchEffort();
  };
  let chatPoll = 0;
  const stopPolling = () => { if (chatPoll) { clearInterval(chatPoll); chatPoll = 0; } };
  globalThis.__cceChatHook = () => {
    // Being called at all proves the patch is in, so the fallback below has nothing left to do.
    stopPolling();
    try { followChat(); } catch (e) { /* never break the host's own setter */ }
  };
  /* The fallback, for a Claude Code build whose shape the patch could not match: without it the view would sit on one
     conversation with nothing saying why. A tick reads one property and compares a string - no files, no scanning - and
     it stops for good the first time the callback arrives. */
  chatPoll = setInterval(followChat, 1000);
  context.subscriptions.push({
    dispose: () => { stopPolling(); if (globalThis.__cceChatHook) delete globalThis.__cceChatHook; },
  });
  /* A panel reports its time zone as it opens, which is usually after this has activated; the rows are redrawn then
     rather than at the next periodic refresh. */
  globalThis.__cceTzHook = () => {
    try { if (workplan.setTimeZone(clientZone())) workplan.refresh(); } catch (e) { /* never break the host's own message handling */ }
    try { writeClientZone(); } catch (e) { /* the same */ }
  };
  /* A panel can report before this activates, and then only the global above holds its zone. */
  writeClientZone();
  context.subscriptions.push({ dispose: () => { if (globalThis.__cceTzHook) delete globalThis.__cceTzHook; } });
  /* The patched host hands over each editor tab's state as it picks the tab's icon; the title gets the same coloured
     dot the icon carries (src/tabdot.js). */
  globalThis.__cceTabDot = (panel, state) => {
    try {
      const want = tabdot.withDot(panel.title, state, enabled() && !removed());
      if (panel.title !== want) panel.title = want;
    } catch (e) { /* never break the host's own icon update */ }
  };
  context.subscriptions.push({ dispose: () => { if (globalThis.__cceTabDot) delete globalThis.__cceTabDot; } });
  /*
   * Conversations pinned in the session list, kept from Claude Code's transcript cleanup (src/sessionpins.js). The
   * margin it keeps is days, so once every half hour is far more often than it needs; a pin gets a pass of its own a
   * few seconds later, so an old conversation pinned close to its age is not left waiting for the next one.
   */
  let keeping = false;
  const keepPinned = async () => {
    if (keeping || !pinsOn()) return;
    keeping = true;
    try {
      const file = pinsFile();
      const now = sessionPins.read(file);
      const r = await sessionPins.keep({ ids: new Set(now.pinned), times: now.times, days: sessionPins.retentionDays(), margin: pinMargin() });
      const changed = sessionPins.applyPass(file, r);
      if (r.touched || r.errors || r.gone.length) {
        log.appendLine(`pinned conversations: ${r.found} of ${r.pinned} found, ${r.touched} file(s) given a later `
          + `modification time to stay ahead of the transcript cleanup, ${r.gone.length} no longer on disk, ${r.errors} error(s)`);
      }
      if (changed) writeLiveNow();
    } catch (e) {
      log.appendLine('pinned conversations: ' + ((e && e.message) || e));
    } finally { keeping = false; }
  };
  let keepSoon = 0, toldStale = false;
  /* A wider margin moves pinned files forward on the next pass, so that pass is not left waiting half an hour. */
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(PIN_MARGIN_SETTING) && !keepSoon) keepSoon = setTimeout(() => { keepSoon = 0; keepPinned(); }, 5000);
  }));
  /*
   * Called by the patched host from inside its own message handling, so the work is put off rather than done there.
   *
   * A window whose copy of this extension has been installed again over itself still records the pin - keeping the files
   * and the exemption from the archive both read the record - but it leaves the shared stylesheet alone, and that is the
   * only way a pin reaches the panel. Without a word the pin would show as pinned for a few seconds and then go back, so
   * the first time this happens the reader is told why and offered the reload.
   */
  globalThis.__ccePinHook = (id, on) => {
    setTimeout(() => {
      try {
        if (!pinsOn()) return;
        if (!sessionPins.setPinned(pinsFile(), id, on)) return;
        log.appendLine(`pinned conversations: ${on ? 'pinned' : 'unpinned'} ${id}`);
        if (replaced() && !toldStale) {
          toldStale = true;
          offerReload('The pin is saved, but this window is running an earlier build of Work Plan for Claude Code than '
            + 'the one now installed, so the session list here cannot show it. Reload the window to see it.');
        }
        writeLiveNow();
        if (on && !keepSoon) keepSoon = setTimeout(() => { keepSoon = 0; keepPinned(); }, 5000);
      } catch (e) { log.appendLine('pinned conversations: ' + ((e && e.message) || e)); }
    }, 0);
  };
  /* A pin made in another window - one that may not be able to write the stylesheet itself - reaches this one's panels
     as soon as its file changes, rather than at the next periodic refresh. The file is replaced rather than written in
     place, so the folder is what is watched. */
  let pinsWatch = null, pinsSettle = 0;
  try {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    pinsWatch = fs.watch(dir, { persistent: false }, (event, name) => {
      if (name && name !== sessionPins.FILE) return;
      if (pinsSettle) clearTimeout(pinsSettle);
      pinsSettle = setTimeout(() => { pinsSettle = 0; if (pinsOn()) writeLiveNow(); }, 300);
    });
    pinsWatch.on('error', () => { try { pinsWatch.close(); } catch (_) { /* closed */ } pinsWatch = null; });
  } catch (_) { /* the periodic refresh still carries a change across */ }
  /* Read by the patched host each time it works out which conversations are in use and so not to be archived. */
  globalThis.__ccePinnedIds = () => {
    try { return pinsOn() ? sessionPins.read(pinsFile()).pinned : []; } catch (_) { return []; }
  };
  const keepFirst = setTimeout(keepPinned, 60000);
  const keepTimer = setInterval(keepPinned, 30 * 60000);
  context.subscriptions.push({ dispose: () => {
    clearTimeout(keepFirst); clearInterval(keepTimer); if (keepSoon) clearTimeout(keepSoon); if (pinsSettle) clearTimeout(pinsSettle);
    if (pinsWatch) { try { pinsWatch.close(); } catch (_) { /* closed */ } }
    if (globalThis.__ccePinHook) delete globalThis.__ccePinHook;
    if (globalThis.__ccePinnedIds) delete globalThis.__ccePinnedIds;
  } });
  /*
   * Claude Code tabs VS Code did not bring back (src/droppedtabs.js), looked for after Claude Code has started: by then
   * VS Code has put back the tabs it kept and Claude Code has matched them to their conversations. They open where Claude
   * Code opens a tab, and the tab that was in front is put back in front.
   *
   * A conversation still running in another window is not opened a second time. After a reload that window is often the
   * same window before it lost its connection: the dev desktop keeps its extension host, and the conversations running
   * in it, for five minutes once a new window connects, and then ends them. So such a tab is looked at again for a while,
   * and opened once its conversation is running nowhere.
   */
  const FOCUS_GROUP = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']
    .map((n) => `workbench.action.focus${n}EditorGroup`);
  const DROPPED_WAIT_MS = 10 * 60000, DROPPED_RECHECK_MS = 15000;
  const isClaudeTab = (t) => t.input instanceof vscode.TabInputWebview && String(t.input.viewType).includes('claudeVSCodePanel');
  const claudeLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudeTab).map((t) => t.label));
  const stripMark = (t) => tabdot.withDot(t, 'plain', false);
  const reopenTabs = async (list, why) => {
    const group = vscode.window.tabGroups.activeTabGroup, front = group && group.activeTab;
    const at = front ? group.tabs.indexOf(front) : -1, column = group && group.viewColumn;
    let reopened = 0;
    for (const t of list) {
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open', t.sessionId, undefined, undefined, undefined, t.fullEditor,
          { programmatic: 'pin-to-panel' });
        reopened++;
      } catch (e) { log.appendLine(`reopening "${t.title}" (${t.sessionId}): ${e && e.message}`); }
    }
    log.appendLine(`Reopened ${reopened} Claude Code tab(s) VS Code did not restore${why}: ${list.map((t) => `"${t.title}"`).join(', ')}`);
    if (reopened) vscode.window.setStatusBarMessage(`Reopened ${reopened} Claude Code tab${reopened === 1 ? '' : 's'} VS Code did not restore`, 10000);
    if (at >= 0 && FOCUS_GROUP[column - 1]) {
      try {
        await vscode.commands.executeCommand(FOCUS_GROUP[column - 1]);
        await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', at);
      } catch (_) { /* the reopened tab stays in front */ }
    }
  };
  let droppedTries = 0, droppedTimer = setTimeout(function lookForDropped() {
    droppedTimer = undefined;
    const atStart = globalThis.__cceTabsAtStart, shown = globalThis.__cceSessionsShown;
    if (!Array.isArray(atStart) || typeof shown !== 'function') {
      if (++droppedTries < 45) droppedTimer = setTimeout(lookForDropped, 2000);
      return;
    }
    if (!enabled() || removed() || cfg().get(REOPEN_SETTING, true) === false) return;
    const elsewhere = () => { try { return typeof globalThis.__cceSessionsElsewhere === 'function' ? globalThis.__cceSessionsElsewhere() : []; } catch (_) { return []; } };
    let lost, waiting;
    try {
      ({ now: lost, later: waiting } = droppedTabs.split({ record: atStart, shown: shown(), elsewhere: elsewhere(), labels: claudeLabels(), strip: stripMark }));
    } catch (e) { log.appendLine('looking for Claude Code tabs VS Code did not restore: ' + (e && e.message)); return; }
    if (lost.length) reopenTabs(lost, '').catch(() => {});
    if (!waiting.length) return;
    log.appendLine(`Waiting to reopen ${waiting.length} Claude Code tab(s) VS Code did not restore, whose conversation is still running in `
      + `another window: ${waiting.map((t) => `"${t.title}"`).join(', ')}`);
    const until = Date.now() + DROPPED_WAIT_MS;
    droppedTimer = setTimeout(function recheck() {
      droppedTimer = undefined;
      let ready = [];
      try {
        ({ ready, waiting } = droppedTabs.settle({ waiting, shown: shown(), elsewhere: elsewhere(), labels: claudeLabels(), strip: stripMark }));
      } catch (_) { waiting = []; }
      if (ready.length) reopenTabs(ready, ' once its conversation stopped running elsewhere').catch(() => {});
      if (waiting.length && Date.now() < until) droppedTimer = setTimeout(recheck, DROPPED_RECHECK_MS);
      else if (waiting.length) log.appendLine(`Not reopened, still running in another window: ${waiting.map((t) => `"${t.title}"`).join(', ')}`);
    }, DROPPED_RECHECK_MS);
  }, 5000);
  context.subscriptions.push({ dispose: () => {
    if (droppedTimer) clearTimeout(droppedTimer);
    if (globalThis.__cceTabsAtStart) delete globalThis.__cceTabsAtStart;
    if (globalThis.__cceSessionsShown) delete globalThis.__cceSessionsShown;
    if (globalThis.__cceSessionsElsewhere) delete globalThis.__cceSessionsElsewhere;
  } });
  /*
   * Archived conversations deleted from disk, asked for from the Archived sessions menu (src/deletesession.js). Nothing
   * goes before the person accepts a confirmation that names each conversation and what of it is on disk. One that is
   * open in this window or running anywhere on this machine is left alone and named as such.
   */
  globalThis.__cceDeleteHook = (asked) => {
    (async () => {
      const seen = new Set(), want = [];
      for (const s of Array.isArray(asked) ? asked : []) {
        if (s && typeof s.id === 'string' && deleteSession.SESSION.test(s.id) && !seen.has(s.id)) {
          seen.add(s.id);
          want.push({ id: s.id, title: typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 120) : s.id });
        }
      }
      if (!want.length || !enabled() || removed()) return;
      let shown = [];
      try { shown = typeof globalThis.__cceSessionsShown === 'function' ? globalThis.__cceSessionsShown() : []; } catch (_) { /* none known */ }
      const busy = [], go = [];
      for (const w of want) {
        if (shown.includes(w.id) || deleteSession.running(w.id)) { busy.push(w); continue; }
        const found = deleteSession.find(w.id, {
          planDir: planDir(),
          extra: installs(webview).map((d) => path.join(d, 'webview', webview.EFFORT_PREFIX + w.id + '.css')),
        });
        if (found.length) go.push({ ...w, found });
      }
      if (!go.length) {
        vscode.window.showInformationMessage(busy.length
          ? `Not deleted: ${busy.map((b) => `"${b.title}"`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} open or running.`
          : 'Nothing of that conversation is left on disk.');
        return;
      }
      const lines = go.map((g) => `"${g.title}": ${deleteSession.describe(g.found)}`);
      if (busy.length) lines.push('', `Left alone, open or running: ${busy.map((b) => `"${b.title}"`).join(', ')}`);
      lines.push('', 'This cannot be undone.');
      const pick = await vscode.window.showWarningMessage(
        go.length === 1 ? `Delete "${go[0].title}" from disk?` : `Delete ${go.length} conversations from disk?`,
        { modal: true, detail: lines.join('\n') }, 'Delete');
      if (pick !== 'Delete') return;
      const failed = [];
      for (const g of go) {
        failed.push(...deleteSession.remove(g.found));
        try { sessionPins.setPinned(pinsFile(), g.id, false); } catch (_) { /* not pinned */ }
        log.appendLine(`Deleted "${g.title}" (${g.id}): ${deleteSession.describe(g.found)}`);
      }
      try { if (typeof globalThis.__cceSessionsChanged === 'function') globalThis.__cceSessionsChanged(); } catch (_) { /* the list catches up on its next read */ }
      if (failed.length) {
        log.appendLine('Could not delete:\n  ' + failed.join('\n  '));
        vscode.window.showWarningMessage(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted; the output "Work Plan for Claude Code" lists them.`);
      }
    })().catch((e) => log.appendLine('deleting archived conversations: ' + (e && e.message)));
  };
  context.subscriptions.push({ dispose: () => {
    if (globalThis.__cceDeleteHook) delete globalThis.__cceDeleteHook;
    if (globalThis.__cceSessionsChanged) delete globalThis.__cceSessionsChanged;
  } });
  /*
   * The tabs closed in this workspace, kept across reloads for Recently closed above OPEN SESSIONS
   * (src/recentclosed.js). The patched host reports each tab the person closes and asks for the list each time it tells
   * the panels which conversations are open, so a closing shows at once.
   */
  let recentList = context.workspaceState.get(recentClosed.KEY, []);
  globalThis.__cceClosedHook = (id) => {
    try {
      recentList = recentClosed.record(recentList, id);
      Promise.resolve(context.workspaceState.update(recentClosed.KEY, recentList)).catch(() => {});
    } catch (_) { /* the list stays as it was */ }
  };
  globalThis.__cceRecentClosed = () => recentClosed.pageData(recentList, enabled() && !removed() ? cfg().get(RECENT_SETTING, 10) : 0);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(RECENT_SETTING) || e.affectsConfiguration(SETTING)) {
      try { if (typeof globalThis.__cceSendSessionStates === 'function') globalThis.__cceSendSessionStates(); } catch (_) { /* next update */ }
    }
  }), { dispose: () => {
    if (globalThis.__cceClosedHook) delete globalThis.__cceClosedHook;
    if (globalThis.__cceRecentClosed) delete globalThis.__cceRecentClosed;
    if (globalThis.__cceSendSessionStates) delete globalThis.__cceSendSessionStates;
  } });
  refreshPlans();
  paintBadge();
  watchEffort();

  /*
   * The plugin that writes the plans travels inside this extension, so the only thing left is to register it with
   * Claude Code. That is done once and then recorded, and it is deliberately not awaited: activation must not sit and
   * wait on a 241 MB binary, and the outcome shows up in the view either way.
   *
   * Skipped entirely for someone who asked this extension to leave Claude Code alone - that request is about all of it,
   * not only the patched files.
   */
  const syncPlugin = async (retry) => {
    if (removed()) return;
    const state = context.globalState.get(PLUGIN_KEY, {});
    const from = path.join(context.extensionPath, 'claude-plugin');
    /* What is compared is the plugin's own contents, not this extension's version: the version changes when a release is
       cut, so a plugin file that changed without one was staged once and never again, and the registered plugin kept
       running the older file. Nothing said so, because the state recorded agreed with itself. */
    const stamp = pluginInstall.digest(from);
    const to = path.join(context.globalStorageUri.fsPath, 'claude-plugin');
    /* The memory of having registered is kept by the editor and outlives an uninstall of this extension, while the
       uninstall unregisters the plugin and its marketplace together. Both missing from Claude Code's own records is
       that, and then the plugin is registered again; the plugin alone missing is somebody's deliberate removal, and is
       left alone (see registrationGone). */
    const undone = state.registered === true && pluginInstall.registrationGone();
    const registered = state.registered === true && !undone;
    /* The registration points at the copy in this extension's global storage, and the editor deletes that folder along
       with an uninstalled extension - so the registration can outlive the files it names. */
    const staged = fs.existsSync(path.join(to, pluginInstall.PLUGIN));
    if (!retry && registered && state.stamp === stamp && staged) return;
    if (undone) log.appendLine('work plan plugin: registering again - Claude Code lists neither it nor its marketplace, which is what uninstalling this extension leaves');
    // A registered plugin on a new version of this extension needs its files refreshed, not registering again: the
    // path stays where it is, and re-running the install is what would undo a deliberate uninstall.
    const refreshOnly = !retry && registered;
    const dirs = [];
    for (const adapter of ADAPTERS) for (const d of installs(adapter)) dirs.push(d);
    const claudeBin = pluginInstall.findClaude(dirs);
    if (!claudeBin && !refreshOnly) {
      const problem = { step: 'finding Claude Code\'s own command line', said: 'Looked for ' + pluginInstall.BINARY + ' in ' + (dirs.length || 'no') + ' install(s) of Claude Code.' };
      workplan.setProblem(problem);
      log.appendLine('work plan plugin: ' + problem.step + ': ' + problem.said);
      return;
    }
    const result = await pluginInstall.install({ claudeBin, from, to, refreshOnly });
    log.appendLine('work plan plugin: ' + (result.ok ? result.said : result.step + ' failed: ' + result.said));
    if (result.ok) {
      await context.globalState.update(PLUGIN_KEY, { registered: true, stamp, error: '' });
      workplan.setProblem(null);
      refreshPlans();
    } else {
      await context.globalState.update(PLUGIN_KEY,
        { registered, stamp: state.stamp, error: result.step + ': ' + result.said });
      workplan.setProblem(result);
    }
  };
  syncPlugin(false);

  /* A work plan is written by another process, so a watcher is what makes an edit show up at once. Its base is outside
     the workspace on purpose - that is where the plugin keeps its data - and the interval below is the fallback,
     because a watcher out there is a courtesy rather than a guarantee.
     The base is the directory every plugin's data sits under, not ours: ours does not exist until the plugin is
     installed, and a watcher cannot be given a base that is not there yet. */
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(DATA_ROOT), PLAN_DIR + '/*.json'));
    watcher.onDidCreate(refreshPlans);
    watcher.onDidChange(refreshPlans);
    watcher.onDidDelete(refreshPlans);
    context.subscriptions.push(watcher);
  } catch (e) {
    log.appendLine('work plan watcher not available: ' + e.message);
  }
  const planPoll = setInterval(refreshPlans, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(planPoll) });
  /*
   * Reaching the file is an action of its own rather than what a row does when clicked: a row is a task, and opening a
   * file of JSON is not what clicking one looks like it will do. The title bar reaches the file for the conversation
   * being looked at; a row's context menu reaches the file that row came from.
   */
  context.subscriptions.push(
    registerCommand('refreshWorkPlan', () => { workplan.refresh(); paintBadge(); }),
    registerCommand('installWorkPlanPlugin', () => syncPlugin(true)),
    /*
     * Modal, because the description is the thing being read and a notification that slides away is not readable. It is
     * registered without being declared in the manifest, so it stays out of the command palette: it is only ever
     * invoked by a row, and carries everything it shows in its argument.
     *
     * It shows the whole description because the description is already bounded where it is read in (see MAX_DETAIL in
     * src/workplan.js), so it cannot overflow the dialog. There is deliberately no way from here to a roomier view: an
     * easy way to read a long description is an invitation to write one, and a task's description is for what the next
     * person needs in order to pick the task up, not for the story of how it got here. Whatever was cut is still in the
     * file, which the title bar opens.
     */
    registerCommand('showWorkPlanDetail', (row) => {
      if (!row) return;
      const head = [[row.state, row.note].filter(Boolean).join(' · ')];
      if (row.times) head.push(row.times);
      if (row.path && row.path.length) head.push('in: ' + row.path.join(' › '));
      if (row.children) head.push(row.children + ' of its own to finish first');
      const body = row.detail || 'No description was written for this one.';
      vscode.window.showInformationMessage(row.title, { modal: true, detail: head.concat(['', body]).join('\n') });
    }),
    registerCommand('openWorkPlanFile', async (element) => {
      let file = element && element.plan && element.plan.file;
      if (!file) {
        const plans = workplan.plans;
        if (!plans.length) {
          vscode.window.showInformationMessage('Work Plan for Claude Code: no conversation on this machine is keeping a work plan.');
          return;
        }
        if (plans.length === 1) file = plans[0].file;
        else {
          const pick = await vscode.window.showQuickPick(
            plans.map((p) => ({ label: p.label, description: p.session, file: p.file })),
            { title: 'Which work plan?' });
          if (!pick) return;
          file = pick.file;
        }
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
  );

  return sync();
}

/*
 * Runs on every reload and every window that closes, and acts only on an uninstall: then it puts Claude Code back at
 * once, rather than leaving the patched files in place until the editor deletes this folder (see src/removal.js).
 *
 * Synchronous and without the editor's API, both for the same reason: the host is shutting down. It gives deactivate five
 * seconds, and restoring takes well under one; unregistering the companion plugin can take longer, so that part is
 * handed to a process that outlives the host.
 */
function deactivate() {
  if (!selfPath || !removal.beingUninstalled(selfPath, ID)) return;
  try { removal.restoreAll(removal.roots(path.dirname(selfPath))); } catch (_) { /* the editor's own hook runs later */ }
  try { removal.finishLater(selfPath); } catch (_) { /* likewise */ }
}

module.exports = { activate, deactivate, renameSettings };

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Claude Code Extras — user interface additions for the Claude Code panel in VS Code.
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
const { safeColor } = webview;
const { readTasks } = require('./src/tasks');
const { countOpen, DATA_ROOT, PLAN_DIR } = require('./src/workplan');
const { WorkPlanProvider } = require('./src/workplan-view');
const pluginInstall = require('./src/plugin-install');
const latency = require('./src/openlatency');
const ADAPTERS = require('./src/adapters');

const SETTING = 'claudeCodeExtras.enabled';
const COLOR_SETTING = 'claudeCodeExtras.userMessageColor';
const EDGE_SETTING = 'claudeCodeExtras.userMessageEdge';
const STATUS_BAR_SETTING = 'claudeCodeExtras.showStatusBar';
const REMOVED_KEY = 'claudeCodeExtras.removed';
const PLUGIN_KEY = 'claudeCodeExtras.workPlanPlugin';
const SWEEP_KEY = 'claudeCodeExtras.lastOrphanSweep';
const LATENCY_KEY = 'claudeCodeExtras.latencyOffset';
const THRESHOLD_SETTING = 'claudeCodeExtras.latencyThresholdSeconds';
const LATENCY_ON_SETTING = 'claudeCodeExtras.recordOpenLatency';
/* Read by the plugin's hooks, which are separate processes and cannot see editor settings. Keys match plan_path.py. */
const HOOK_SETTINGS = {
  enabled: 'claudeCodeExtras.workPlan',
  offerMinTurns: 'claudeCodeExtras.workPlanOfferMinTurns',
  offerMinToolCalls: 'claudeCodeExtras.workPlanOfferMinToolCalls',
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

function activate(context) {
  const log = vscode.window.createOutputChannel('Claude Code Extras');
  context.subscriptions.push(log);
  /*
   * When this host started, so that the patch write can be placed against the panel's own startup.
   *
   * The panel logs how far into its startup its bundle finished evaluating; this gives the other half of the comparison -
   * how far into the same startup we replaced that bundle. Without it the only way to line the two up was the file's
   * modification time, which says nothing about when startup began and is gone as soon as the next write lands.
   *
   * TEMPORARY, part of the investigation at writeAtomic in src/webview.js. Goes when that is settled.
   */
  const startedAt = Date.now();
  const removed = () => context.globalState.get(REMOVED_KEY, false) === true;

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
  const switchedOff = () => webview.SWITCHES.filter((k) => cfg().get('claudeCodeExtras.show.' + k, true) === false);
  const options = () => ({
    enabled: enabled(), userColor: cfg().get(COLOR_SETTING, ''), userEdge: cfg().get(EDGE_SETTING, true) !== false,
    off: switchedOff(),
    tasks: readTasks(knownDirs()),
  });

  /* Bring every install in line with the current settings. Only installing, upgrading or removing the patch itself
     asks for a reload; on and off and the color are picked up by an open panel within a couple of seconds. */
  async function sync({ interactive = false } = {}) {
    const patched = [], restored = [], problems = [];
    let found = 0;
    for (const adapter of ADAPTERS) {
      for (const dir of installs(adapter)) {
        found++;
        const label = `${adapter.name} (${path.basename(dir)})`;
        try {
          if (removed()) {
            const r = adapter.restore(dir);
            log.appendLine(`${label}: ${r.message}`);
            if (r.changed && !restored.includes(adapter.name)) restored.push(adapter.name);
          } else {
            /* Where the panel's bundle is rewritten. Doing it HERE - during startup, while the panel is loading that same
               file - is the leading suspect for the panel that takes minutes to open, and all three ways out change this call
               or its timing. Read writeAtomic in src/webview.js first: the evidence, the test that settles it, and what each
               option costs are written there. */
            const intoStartup = Date.now() - startedAt;
            const t0 = Date.now();
            const r = adapter.apply(dir, options());
            const took = Date.now() - t0;
            /* TEMPORARY, part of that same investigation: how far into startup the file was replaced and how long the
               replacement took. The panel logs the other half - how far into its own startup its bundle finished
               evaluating - and the two together say whether they overlapped, which no amount of reasoning about the file's
               modification time could settle. Only for a write: "already patched" touches nothing, and logging it here
               would bury the case that matters among the ones that cannot have caused anything. */
            if (r.changed) {
              log.appendLine(`${label}: ${r.message} - wrote at ${intoStartup}ms into this host's startup, took ${took}ms`);
              try {
                latency.patchRecord({ dir: latencyDir(), version: stamp(), target: adapter.name,
                  intoStartup, took, at: new Date(t0).toISOString() });
              } catch (_) { /* a reading that cannot be filed is not worth failing activation over */ }
            } else {
              log.appendLine(`${label}: ${r.message}${r.liveChanged ? ' (live settings updated)' : ''}`);
            }
            if (r.changed && !patched.includes(adapter.name)) patched.push(adapter.name);
            else if (!r.changed && r.message !== 'already patched') problems.push(`${label}: ${r.message}`);
          }
        } catch (e) {
          problems.push(`${label}: ${e.message}`);
          log.appendLine(`${label}: error ${e.stack || e.message}`);
        }
      }
    }
    if (!found && interactive) vscode.window.showWarningMessage('Claude Code Extras: the Claude Code extension is not installed, so there is nothing to patch.');
    // A shape mismatch after a Claude Code update would otherwise be silent, so it is said out loud.
    if (problems.length) vscode.window.showWarningMessage('Claude Code Extras: ' + problems.join(' | '));
    if (patched.length) offerReload(`Claude Code Extras is installed in ${patched.join(' and ')}. Reload the window once to start; after that, On/Off and colors change live.`);
    if (restored.length) offerReload(`Claude Code Extras was removed from ${restored.join(' and ')}. Reload the window to finish.`);
  }

  // Status bar toggle: shows the current state and flips it on click.
  const bar = vscode.window.createStatusBarItem('claudeCodeExtras.toggle', vscode.StatusBarAlignment.Left, 50);
  bar.name = 'Claude Code Extras';
  bar.command = 'claudeCodeExtras.toggle';
  const renderBar = () => {
    const on = enabled() && !removed();
    bar.text = on ? '$(clock) Extras: On' : '$(circle-slash) Extras: Off';
    bar.tooltip = on ? 'Claude Code Extras is ON — click to turn it off' : 'Claude Code Extras is OFF — click to turn it on';
    if (cfg().get(STATUS_BAR_SETTING, true)) bar.show(); else bar.hide();
  };
  context.subscriptions.push(bar);

  const setEnabled = async (value) => {
    if (value && removed()) await context.globalState.update(REMOVED_KEY, false);
    if (enabled() === value) { renderBar(); await sync({ interactive: true }); return; }
    await cfg().update(SETTING, value, vscode.ConfigurationTarget.Global);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeExtras.enable', () => setEnabled(true)),
    vscode.commands.registerCommand('claudeCodeExtras.disable', () => setEnabled(false)),
    vscode.commands.registerCommand('claudeCodeExtras.toggle', () => setEnabled(!(enabled() && !removed()))),
    vscode.commands.registerCommand('claudeCodeExtras.remove', async () => {
      await context.globalState.update(REMOVED_KEY, true);
      renderBar();
      await sync({ interactive: true });
    }),
    vscode.commands.registerCommand('claudeCodeExtras.status', () => {
      const lines = [];
      for (const adapter of ADAPTERS) for (const d of installs(adapter)) lines.push(`${adapter.name} ${path.basename(d)}: ${adapter.status(d)}`);
      vscode.window.showInformationMessage('Claude Code Extras — ' + (lines.join(' | ') || 'Claude Code is not installed') + (removed() ? ' (removed)' : ''));
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
    vscode.commands.registerCommand('claudeCodeExtras.disableWorkPlanPlugin', async () => {
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
    vscode.commands.registerCommand('claudeCodeExtras.openSettings',
      () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xnerv.claude-code-extras')),
    /* Reads the records rather than measuring anything, so it is also the way to see them after a window restart. */
    vscode.commands.registerCommand('claudeCodeExtras.showOpenLatency', () => {
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
      if (e.affectsConfiguration(SETTING) || e.affectsConfiguration(STATUS_BAR_SETTING)) renderBar();
      if (Object.values(HOOK_SETTINGS).some((k) => e.affectsConfiguration(k))) writeHookSettings();
      /* A switch has to reach the panel the moment it is flipped, which is what writing the stylesheet does. */
      const touched = [SETTING, COLOR_SETTING, EDGE_SETTING]
        .concat(webview.SWITCHES.map((k) => 'claudeCodeExtras.show.' + k));
      if (!touched.some((k) => e.affectsConfiguration(k))) return;
      const c = cfg().get(COLOR_SETTING, '');
      if (c && !safeColor(c)) vscode.window.showWarningMessage(`Claude Code Extras: "${c}" is not a CSS color (use e.g. #90EE90, lightgreen or rgb(144,238,144)); your message color is left unchanged.`);
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
    if (removed() || !enabled()) return;
    try {
      const opts = options();
      for (const dir of installs(webview)) webview.writeLive(dir, opts);
    } catch (e) {
      log.appendLine('live refresh failed: ' + e.message);
    }
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
  /* The running count of fast opens lives here rather than in globalState: that store is shared by every window, so two
     of them incrementing one counter would lose each other's increments - the same reason the records are a file each. */
  let latencyState = context.globalState.get(LATENCY_KEY, {});
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
      if (r.state) {
        latencyState = r.state;
        /* The offset and any half-finished pairing survive a restart; a half-counted day does not, and writing the count
           on every tick would put a store every window shares back in the path of something each counts for itself. */
        context.globalState.update(LATENCY_KEY,
          { file: r.state.file, size: r.state.size, pending: r.state.pending });
      }
      /* Anything recorded is already past the threshold, so it is worth saying without being asked. */
      for (const w of r.added) {
        log.appendLine(`waited ${(w.waited / 1000).toFixed(1)}s for ${w.what} (${w.trigger}) at ${w.at}`);
      }
    } catch (e) {
      log.appendLine('open latency: ' + e.message);
    }
  }
  sampleLatency();

  /*
   * TEMPORARY, FOR ONE INVESTIGATION - delete with the watcher in src/openlatency.js once the panel's slow first message
   * is understood. A per-second timer is not something this extension should carry for its own sake; it is here because
   * one question could not be answered any other way.
   *
   * Whether this extension host was running during a wait, which a wait on its own cannot say.
   *
   * The silence either side of a 94-second wait has two opposite readings - this host blocked and unable to act, or this
   * host idle with nothing to act on - and they point at different halves of the machine. A timer that only reads the
   * clock tells them apart: late means this side was busy, on time through a long wait means it was free and the delay
   * belongs to the panel.
   *
   * On its own interval rather than the thirty-second one above: a timer cannot measure a delay that also delayed it, and
   * the sampling has to be finer than what it is trying to see. Under the same setting as the rest of the recording,
   * since it is the same kind of data about the same question.
   */
  const lag = latency.lagWatcher({ dir: latencyDir(), version: stamp() });
  let lastLag = null;
  const lagTimer = setInterval(() => {
    if (!cfg().get(LATENCY_ON_SETTING, true)) return;
    try {
      const over = lag.tick();
      // Reported as a stretch ends, with its whole span, rather than once per late tick.
      if (!over && lag.records.length && lag.records[lag.records.length - 1] !== lastLag) {
        lastLag = lag.records[lag.records.length - 1];
        log.appendLine(`this extension host was busy ${(lastLag.blocked / 1000).toFixed(1)}s from ${lastLag.at}`);
      }
    } catch (_) { /* a missed reading is not worth a message every second */ }
  }, latency.INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(lagTimer) });

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
    }
    const file = path.join(PLAN_DIR, 'config.json');
    const next = JSON.stringify(values, null, 2) + '\n';
    try {
      let current = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch (_) {}
      /* Several windows write this, and they all write the same thing from the same settings - so comparing first keeps
         them from taking turns rewriting one file, the way the live stylesheet already does. */
      if (current === next) return;
      fs.mkdirSync(PLAN_DIR, { recursive: true });
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
    const r = workplan.sweepOrphans();
    if (r.why) log.appendLine('orphan work plans: ' + r.why);
    else if (r.deleted) log.appendLine(`orphan work plans: deleted ${r.deleted}, kept ${r.kept}`);
  };
  const refreshPlans = () => {
    sweepPlans().catch((e) => log.appendLine('orphan work plans: ' + e.message));
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
  const followChat = () => {
    const id = activeChat();
    if (!workplan.setFocus(id)) return;
    log.appendLine('active conversation: ' + (id || '(none reported)'));
    workplan.refresh();
    paintBadge();
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
  refreshPlans();
  paintBadge();

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
    const registered = state.registered === true;
    if (!retry && registered && state.stamp === stamp) return;
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
    const result = await pluginInstall.install({
      claudeBin,
      from,
      to: path.join(context.globalStorageUri.fsPath, 'claude-plugin'),
      refreshOnly,
    });
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
    vscode.commands.registerCommand('claudeCodeExtras.refreshWorkPlan', () => { workplan.refresh(); paintBadge(); }),
    vscode.commands.registerCommand('claudeCodeExtras.installWorkPlanPlugin', () => syncPlugin(true)),
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
    vscode.commands.registerCommand('claudeCodeExtras.showWorkPlanDetail', (row) => {
      if (!row) return;
      const head = [[row.state, row.note].filter(Boolean).join(' · ')];
      if (row.times) head.push(row.times);
      if (row.path && row.path.length) head.push('in: ' + row.path.join(' › '));
      if (row.children) head.push(row.children + ' of its own to finish first');
      const body = row.detail || 'No description was written for this one.';
      vscode.window.showInformationMessage(row.title, { modal: true, detail: head.concat(['', body]).join('\n') });
    }),
    vscode.commands.registerCommand('claudeCodeExtras.openWorkPlanFile', async (element) => {
      let file = element && element.plan && element.plan.file;
      if (!file) {
        const plans = workplan.plans;
        if (!plans.length) {
          vscode.window.showInformationMessage('Claude Code Extras: no conversation on this machine is keeping a work plan.');
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

  renderBar();
  return sync();
}

function deactivate() {}

module.exports = { activate, deactivate };

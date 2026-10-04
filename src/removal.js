// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Taking this extension's changes back out of Claude Code when this extension is uninstalled - at the moment the editor
 * restarts its extensions afterwards, rather than whenever the editor next gets round to deleting the folder.
 *
 * The editor's own uninstall hook (package.json "vscode:uninstall", which runs uninstall.js) runs when the extension's
 * folder is deleted, and in remote development that happens when the remote server next starts. On the machine this was
 * written on that came eight hours after the uninstall, when the machine happened to reboot; until then every Claude Code
 * panel kept running the patched bundle, with nothing installed that knew how to undo it.
 *
 * What comes sooner: the editor cannot take out an extension that is running ("Extension is running, cannot remove it
 * safely", canRemoveExtension in the workbench's abstractExtensionService.ts), and this one runs from startup, so an
 * uninstall is always followed by a restart of the extension host. A host that shuts down calls every extension's
 * deactivate and waits up to five seconds for it (terminate in extHostExtensionService.ts). That is where this runs.
 *
 * deactivate also runs on every reload and on every window that closes, so an uninstall has to be told apart from those -
 * and without the editor's API, whose proxies are already disposed by the time deactivate is called. The editor's own
 * bookkeeping says it: an uninstall marks this folder in the extensions directory's .obsolete file before the host
 * restarts. An update marks the old folder the same way, so a marked folder means an uninstall only when no other folder
 * of this extension is left unmarked.
 *
 * The same test is what keeps another window from undoing it. A second window's copy of this extension goes on running
 * until that window restarts its own extensions, and an uninstall is exactly the kind of change that makes it bring
 * Claude Code back in line - which, left alone, means patching again what the first window has just restored.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapters = require('./adapters');

/** Every extensions folder Claude Code could be installed in, starting with the one this extension sits in. */
function roots(extensionsDir) {
  const home = os.homedir();
  return Array.from(new Set([
    extensionsDir,
    process.env.VSCODE_EXTENSIONS,
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
  ].filter(Boolean)));
}

/** The folders the editor has marked for deletion, as it records them: a map from folder name to true. */
function obsolete(extensionsDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

/**
 * Whether the editor is taking this copy of the extension away with no other version of it staying behind.
 *
 * `id` is <publisher>.<name>. A folder is named <id>-<version>, with the platform after the version for a platform
 * build, so the pattern requires a digit after the dash - another extension whose name merely starts with this one's is
 * not mistaken for a version of it.
 */
function beingUninstalled(extensionPath, id) {
  if (!extensionPath || !id) return false;
  const dir = path.dirname(extensionPath);
  const mine = path.basename(extensionPath);
  const marked = obsolete(dir);
  if (marked[mine] !== true) return false;
  const own = new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d', 'i');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return false; }
  return !names.some((n) => n !== mine && own.test(n) && marked[n] !== true);
}

/** Put back every Claude Code install that carries a patch of ours. Synchronous, since the host exits right after. */
function restoreAll(dirs) {
  const done = [];
  for (const root of dirs) {
    for (const adapter of adapters) {
      for (const dir of adapter.findInstalls(root)) {
        try { done.push(Object.assign({ dir, name: adapter.name }, adapter.restore(dir))); }
        catch (e) { done.push({ dir, name: adapter.name, changed: false, message: e.message }); }
      }
    }
  }
  return done;
}

/**
 * Hand the rest of the uninstall to a process of its own.
 *
 * What is left is unregistering the companion plugin, which goes through Claude Code's 241 MB command-line binary, and a
 * cold start of that can take longer than the five seconds deactivate is given. A detached child outlives this host. It
 * runs the same uninstall.js the editor runs again when it deletes the folder, and every step in it is safe to repeat.
 */
function finishLater(extensionPath, spawn = cp.spawn) {
  const child = spawn(process.execPath, [path.join(extensionPath, 'uninstall.js')], {
    detached: true,
    stdio: 'ignore',
    // On a desktop install the host's binary is Electron, which runs a script as plain Node only when told to.
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  });
  child.unref();
  return child;
}

/**
 * Whether this copy was replaced on disk after it was loaded: the same version installed again, which leaves a window that
 * has not reloaded running the earlier build.
 *
 * Version numbers cannot order two builds of one version, and between releases the version is left alone, so the rule
 * that keeps an older build from writing over a newer one's files does not separate them. VS Code stamps every install
 * into the manifest it writes, `__metadata.installedTimestamp`, so a stamp on disk that differs from the one read when this
 * copy started means newer code is installed. Until this window reloads it must not patch or write what that build owns.
 *
 * False when either stamp is missing: nothing to compare is no reason to stand down.
 */
function replacedSince(extensionPath, loadedStamp) {
  if (!extensionPath || !loadedStamp) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')).__metadata;
    return !!(meta && meta.installedTimestamp && meta.installedTimestamp !== loadedStamp);
  } catch (_) {
    return false;
  }
}

/** The install stamp of the copy at extensionPath as it is on disk now, or 0 when it cannot be read. */
function installStamp(extensionPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')).__metadata;
    return (meta && meta.installedTimestamp) || 0;
  } catch (_) {
    return 0;
  }
}

module.exports = { roots, obsolete, beingUninstalled, restoreAll, finishLater, replacedSince, installStamp };

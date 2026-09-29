// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Uninstall hook (package.json "vscode:uninstall"). VS Code runs this with plain Node after the editor restarts.
 *
 * Without it, uninstalling this extension would leave every patched Claude Code file behind — still carrying our
 * marker, still running our script, with nothing left installed that knows how to undo it. So this restores every
 * install it can find, in every extensions folder it can think of.
 *
 * The adapter list comes from src/adapters.js, the same list the entry point uses, so a target cannot be wired into
 * one and forgotten here.
 *
 * It also unregisters the companion Claude Code plugin, because one thing was installed and one thing has to be enough
 * to uninstall. Unregistering deletes the plugin's data directory, and the work plans live in it, so they are copied to
 * ~/.claude/agent-work-plan-plans-<timestamp>/ first, with a note in there saying what they are. They are somebody's own
 * writing; uninstalling an editor extension is not a request to delete it.
 *
 * The staged copy of the plugin in this extension's global storage is left where it is: that is the editor's own space
 * to reclaim, and nothing reads it once the marketplace entry is gone.
 */
const os = require('os');
const path = require('path');
const adapters = require('./src/adapters');
const pluginInstall = require('./src/plugin-install');

const home = os.homedir();
const roots = [
  path.dirname(__dirname),                        // the folder this extension itself was installed in
  process.env.VSCODE_EXTENSIONS,
  path.join(home, '.vscode', 'extensions'),
  path.join(home, '.vscode-insiders', 'extensions'),
  path.join(home, '.vscode-server', 'extensions'),
].filter(Boolean);

const found = [];
for (const root of Array.from(new Set(roots))) {
  for (const adapter of adapters) {
    for (const dir of adapter.findInstalls(root)) {
      found.push(dir);
      try { adapter.restore(dir); } catch (_) { /* leave it; Claude Code's next update replaces the files anyway */ }
    }
  }
}

/* The command line that unregisters the plugin lives inside Claude Code, so this only works while Claude Code is still
   installed. If it is already gone, so is the binary - and so is anything that would load the plugin. */
/* No binary means Claude Code is already gone, and with it anything that would load the plugin or delete its data. Then
   there is nothing to unregister and nothing at risk, so the plans are left exactly where they are. */
const claudeBin = pluginInstall.findClaude(found);
if (claudeBin) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  pluginInstall.removeSync(claudeBin, stamp);
}

'use strict';
/*
 * Registering the companion Claude Code plugin, once.
 *
 * The plugin is carried inside this extension rather than fetched, so that installing one thing is enough. What is left
 * to do is tell Claude Code about it, which is two commands against the `claude` binary - and that binary ships inside
 * the Claude Code extension, the same directory this extension already has to find in order to patch it.
 *
 * A directory marketplace loads a plugin IN PLACE rather than copying it ("it loads in place from <path>, so edits
 * there take effect at the next session start"). So the path registered has to outlive an upgrade of this extension,
 * and this extension's own install directory does not: it carries a version number and is replaced every upgrade. The
 * plugin is therefore copied into global storage, which the editor keeps across versions, and that copy is registered.
 *
 * Registration happens silently and exactly once. Silently because there is nothing for a reader to decide - the thing
 * being installed is the other half of what they just installed, and it reaches nothing but this machine. Exactly once
 * because re-asserting it on every start is how an installer overwrites what somebody changed by hand: a person who
 * uninstalls the plugin on purpose must not find it back the next morning.
 *
 * The staged copy is refreshed when this extension's version changes, which is a different thing from re-asserting the
 * registration: the registered path does not move, and refreshing the files under it is the only way the plugin half
 * stays on the same version as the half that reads what it writes. It leaves the registration alone, so a deliberate
 * uninstall still stands.
 *
 * Failure is recorded rather than swallowed. An install that runs by itself can fail by itself, and a feature that is
 * quietly missing reads as a broken feature - so the view shows what failed and offers to try again.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKETPLACE = 'claude-code-extras';
const PLUGIN = 'agent-work-plan';
/** How the plugin is named once it is installed: <plugin>@<marketplace>. */
const REF = PLUGIN + '@' + MARKETPLACE;
/** The directory the platform gives the plugin for its own data, named from those two. */
const DATA_DIR = PLUGIN + '-' + MARKETPLACE;
const dataPath = () => path.join(os.homedir(), '.claude', 'plugins', 'data', DATA_DIR);
/** Where Claude Code keeps the command-line binary inside its own extension directory. */
const BINARY = path.join('resources', 'native-binary', 'claude');
/* Generous, because this binary is a 241 MB single file: a cold start of it is slow on a machine that has just booted,
   and a timeout here would be reported as a failure that is really only a wait. */
const TIMEOUT_MS = 60000;

/** The first Claude Code install that carries a runnable binary. */
function findClaude(dirs) {
  for (const dir of dirs || []) {
    const bin = path.join(dir, BINARY);
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (_) { /* try the next install */ }
  }
  return '';
}

/** The last line of what a command said, which is the part written for a person to read. */
function lastLine(stdout, stderr, err) {
  const text = (String(stdout || '') + String(stderr || '')).trim();
  if (text) return text.split('\n').pop().trim();
  return err ? err.message : '';
}

function run(bin, args) {
  return new Promise((resolve) => {
    cp.execFile(bin, args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ ok: !err, said: lastLine(stdout, stderr, err) });
    });
  });
}

/*
 * The staged copy is replaced rather than written over, so a version that dropped a file does not leave it behind to be
 * loaded. The cost is a moment where the registered path does not exist; a session starting inside that moment sees no
 * plugin and picks it up at the next one.
 */
/*
 * A digest of the plugin tree - every file's path and its bytes.
 *
 * This is what decides whether the staged copy is out of date, in place of this extension's version string. A version
 * changes when a release is cut, not when a file changes, so a plugin file edited between releases was copied once and
 * never again: the registered plugin went on running the older file with nothing anywhere saying so. The patched panel
 * script is keyed on a digest for the same reason.
 *
 * Returns an empty string if the tree cannot be read, which reads as "not what is installed" and so stages it again.
 */
function digest(dir) {
  const h = crypto.createHash('sha256');
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const child = rel ? path.join(rel, name) : name;
      const full = path.join(dir, child);
      if (fs.statSync(full).isDirectory()) walk(child);
      else h.update(child).update('\0').update(fs.readFileSync(full));
    }
  };
  try { walk(''); } catch (_) { return ''; }
  return h.digest('hex').slice(0, 16);
}

function stage(from, to) {
  const next = to + '.new';
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, next, { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(next, to);
}

/**
 * Put the plugin where it will keep working, and register it. Returns what to record and what to show.
 *
 * Both commands are idempotent - a second marketplace add says "already on disk", a second install says "already
 * installed" - and both exit zero, so a retry after a partial failure needs no special case.
 */
async function install({ claudeBin, from, to, refreshOnly }) {
  try { stage(from, to); }
  catch (e) { return { ok: false, step: 'copying the plugin to ' + to, said: e.message }; }
  if (refreshOnly) return { ok: true, step: '', said: 'refreshed the staged copy' };
  const added = await run(claudeBin, ['plugin', 'marketplace', 'add', to]);
  if (!added.ok) return { ok: false, step: 'claude plugin marketplace add', said: added.said };
  const installed = await run(claudeBin, ['plugin', 'install', REF]);
  if (!installed.ok) return { ok: false, step: 'claude plugin install ' + REF, said: installed.said };
  // So that the place plans go exists and can be looked at, rather than being a path that only appears once something
  // has already written there.
  try { fs.mkdirSync(dataPath(), { recursive: true }); } catch (_) { /* the first write will make it */ }
  return { ok: true, step: '', said: installed.said };
}

const RESCUE_NOTE = `These are the work plans kept by the agent-work-plan plugin for Claude Code: one file per
conversation, named by that conversation's session id, holding what it still had to do.

They were copied here because the Claude Code Extras extension for VS Code was uninstalled. Unregistering a plugin makes
Claude Code delete the plugin's data directory along with it - "the removal also deletes their saved options, secrets and
data where it can" - and these are not the extension's to delete. Nothing reads this folder; it is yours to keep or
throw away.

To use them again: install the extension, which registers the plugin again, then copy these files back into
~/.claude/plugins/data/${DATA_DIR}/
`;

/**
 * Copy the plans somewhere the platform will not reach, and return where they went.
 *
 * Both ways of unregistering take the plugin's data directory with them: `marketplace remove` says so itself, and
 * `plugin uninstall` does the same without saying it. Verified, not assumed - a file left in that directory is gone
 * after either command. The plans are somebody's own writing, possibly months of it, and uninstalling a VS Code
 * extension is not a request to delete it.
 *
 * A copy rather than a move, so that a failure halfway leaves the original untouched; the platform removes it moments
 * later anyway.
 */
function rescuePlans(stamp) {
  const from = dataPath();
  let names;
  try { names = fs.readdirSync(from); } catch (_) { return ''; }
  if (!names.length) return '';
  const to = path.join(os.homedir(), '.claude', PLUGIN + '-plans-' + stamp);
  try {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    fs.writeFileSync(path.join(to, 'WHAT-THIS-IS.txt'), RESCUE_NOTE, 'utf8');
  } catch (_) { return ''; }
  return to;
}

/**
 * Undo both halves of the registration, synchronously, for the uninstall hook - which runs as a plain Node script that
 * exits when it is done, so there is nothing for an asynchronous version to overlap with.
 *
 * The plans are copied out first, because unregistering deletes them. Returns where they went, or an empty string when
 * there was nothing to save.
 */
function removeSync(claudeBin, stamp) {
  const saved = rescuePlans(stamp);
  for (const args of [['plugin', 'uninstall', REF], ['plugin', 'marketplace', 'remove', MARKETPLACE]]) {
    try { cp.execFileSync(claudeBin, args, { timeout: TIMEOUT_MS, stdio: 'ignore' }); }
    catch (_) { /* already gone, or the binary went with the extension it lived in; either way nothing is left to do */ }
  }
  return saved;
}

module.exports = {
  install, removeSync, rescuePlans, findClaude, digest, MARKETPLACE, PLUGIN, REF, BINARY, DATA_DIR,
};

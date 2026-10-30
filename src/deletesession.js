// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Deleting an archived conversation from disk, asked for from the session list's Archived sessions menu.
 *
 * Claude Code keeps a conversation in several places named after its session ID, and has no way of its own to delete
 * one. This finds every one of them that exists, so the confirmation can say what goes and how much, and then removes
 * exactly those paths:
 *
 *   projects/<project>/<id>.jsonl    the transcript, in every project folder that has one
 *   projects/<project>/<id>/         sub-agent transcripts, saved tool outputs and workflow state
 *   file-history/<id>/               the file checkpoints behind rewind
 *   session-env/<id>/                the environment the conversation's shell started with
 *   debug/<id>.txt                   its debug log
 *   todos/<id>-*.json                its todo lists, from Claude Code versions that kept them
 *
 * and this extension's own files for it: the work plan, its side files and the lock a writer of the plan takes, and the
 * stylesheet the panel reads its effort marks from. A background session started with `claude --bg` is a conversation
 * of its own and is not touched.
 *
 * Every path is built from the ID, which must have the session ID's form, so nothing outside these places can be named;
 * and a session folder that is a symbolic link is removed as a link, never listed through. A conversation still running
 * somewhere is refused: the caller says which are open in this window, and Claude Code's register of running sessions
 * says which are running anywhere on this machine.
 */
const fs = require('fs');
const path = require('path');
const { claudeDir, projectFolders, SESSION } = require('./claude-files');
const { SIDE_SUFFIXES } = require('./workplan');

function list(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

/** Files and bytes under a path, without following links. */
function measure(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return null; }
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0, bytes = 0;
  for (const name of list(p)) {
    const m = measure(path.join(p, name));
    if (m) { files += m.files; bytes += m.bytes; }
  }
  return { files, bytes };
}

/*
 * What deleting each conversation would remove: per ID, each path that exists, what it is, and its size. The project
 * folders are walked once however many conversations are asked about. `planDir` is the work plan's folder, `extra(id)`
 * further files of this extension's for a conversation.
 */
function findAll(ids, { root = claudeDir(), planDir, extra = () => [] } = {}) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && SESSION.test(id)))];
  const out = new Map(want.map((id) => [id, []]));
  if (!want.length) return out;
  const add = (id, p, kind) => { const m = measure(p); if (m) out.get(id).push({ path: p, kind, files: m.files, bytes: m.bytes }); };
  for (const project of projectFolders(path.join(root, 'projects')) || []) {
    const names = new Set(list(project));
    for (const id of want) {
      if (names.has(id + '.jsonl')) add(id, path.join(project, id + '.jsonl'), 'transcript');
      if (!names.has(id)) continue;
      const dir = path.join(project, id);
      let st;
      try { st = fs.lstatSync(dir); } catch (_) { continue; }
      /* Not a folder of its own - a link, most likely: it goes as itself. Listing what it points at would delete
         whatever is there, which can be anywhere. */
      if (!st.isDirectory()) { add(id, dir, 'session data'); continue; }
      for (const name of list(dir)) {
        const kind = name === 'subagents' ? 'sub-agent' : name === 'tool-results' ? 'tool output' : 'session data';
        add(id, path.join(dir, name), kind);
      }
      out.get(id).push({ path: dir, kind: 'folder', files: 0, bytes: 0 });
    }
  }
  const todos = list(path.join(root, 'todos'));
  for (const id of want) {
    add(id, path.join(root, 'file-history', id), 'file checkpoint');
    add(id, path.join(root, 'session-env', id), 'session data');
    add(id, path.join(root, 'debug', id + '.txt'), 'debug log');
    for (const name of todos) if (name.startsWith(id + '-') && name.endsWith('.json')) add(id, path.join(root, 'todos', name), 'session data');
    if (planDir) {
      for (const suffix of SIDE_SUFFIXES) add(id, path.join(planDir, id + suffix), suffix === '.json' ? 'work plan' : 'work plan data');
      add(id, path.join(planDir, id + '.json.lock'), 'work plan data');
    }
    for (const p of extra(id) || []) add(id, p, 'extension data');
  }
  return out;
}

/** What deleting one conversation would remove; `extra` lists further files of this extension's for it. */
function find(id, opts = {}) {
  const extra = Array.isArray(opts.extra) ? opts.extra : [];
  return findAll([id], Object.assign({}, opts, { extra: () => extra })).get(id) || [];
}

/** The conversations Claude Code's register of running sessions has a live process for, read once. */
function runningSessions(root = claudeDir(), alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }) {
  const out = new Set();
  for (const name of list(path.join(root, 'sessions'))) {
    if (!name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(root, 'sessions', name), 'utf8'));
      if (d && typeof d.sessionId === 'string' && Number.isInteger(d.pid) && alive(d.pid)) out.add(d.sessionId);
    } catch (_) { /* a register entry being written */ }
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
function size(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + units[u];
}

/** One line saying what a conversation's paths hold, for the confirmation. */
function describe(found) {
  const count = (kind) => found.filter((f) => f.kind === kind).reduce((n, f) => n + f.files, 0);
  const parts = [];
  const transcripts = found.filter((f) => f.kind === 'transcript').length;
  if (transcripts) parts.push(plural(transcripts, 'transcript'));
  const sub = found.filter((f) => f.kind === 'sub-agent').reduce((n, f) => n + list(f.path).filter((x) => x.endsWith('.jsonl')).length, 0);
  if (sub) parts.push(plural(sub, 'sub-agent conversation'));
  if (count('tool output')) parts.push(plural(count('tool output'), 'saved tool output'));
  if (count('file checkpoint')) parts.push(plural(count('file checkpoint'), 'file checkpoint'));
  if (found.some((f) => f.kind === 'work plan')) parts.push('the work plan');
  if (found.some((f) => f.kind === 'debug log')) parts.push('the debug log');
  const bytes = found.reduce((n, f) => n + f.bytes, 0);
  return (parts.length ? parts.join(', ') : 'session data') + ' (' + size(bytes) + ')';
}

/** Removes the paths `find` returned; the folders last, once emptied. Returns the paths that could not be removed. */
function remove(found) {
  const failed = [];
  const order = [...found.filter((f) => f.kind !== 'folder'), ...found.filter((f) => f.kind === 'folder')];
  for (const f of order) {
    try { fs.rmSync(f.path, { recursive: true, force: true }); }
    catch (e) { failed.push(f.path + ': ' + (e && e.message)); }
  }
  return failed;
}

module.exports = { find, findAll, runningSessions, describe, remove, size, SESSION };

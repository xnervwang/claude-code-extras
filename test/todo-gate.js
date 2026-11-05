// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/todo-gate.js <path to resources/native-binary/claude>. Finds which models get the built-in to-do
 * tools (TodoWrite, TaskCreate and the rest) from the CLI in the Claude Code extension.
 *
 * Since 2.1.233 the CLI withholds them from newer models. The function that decides returns true in a few modes, for an
 * unknown model or an application inference profile, and for a model on a fixed list; otherwise only when
 * CLAUDE_CODE_ENABLE_TODO_TOOLS is set. In 2.1.318 the list ends at Opus 4.7, Sonnet 4.6 and Haiku 4.5, so current
 * models have only the work plan. Exit code 1 means a 5.x model is back on the list, or the check is gone, and the
 * model may stop updating its work plan.
 */
const fs = require('fs');

const SWITCH = Buffer.from('.CLAUDE_CODE_ENABLE_TODO_TOOLS===');
// How far before the switch the list may start; in 2.1.318 it is 330 bytes.
const REACH = 4000;
const SET = /new Set\(\[((?:"[\w.-]+",?)+)\]\)/g;
const CURRENT = /^claude-(?:opus|sonnet|haiku|fable)-(\d+)/;

/** Finds the model list the switch falls back on. */
function gateOf(bytes) {
  const at = bytes.indexOf(SWITCH);
  if (at < 0) return { error: 'CLAUDE_CODE_ENABLE_TODO_TOOLS is no longer compared where the to-do tools are given out' };
  const before = bytes.subarray(Math.max(0, at - REACH), at).toString('latin1');
  const sets = [...before.matchAll(SET)].filter((m) => m[1].includes('"claude-'));
  if (!sets.length) return { error: 'no list of models comes before the CLAUDE_CODE_ENABLE_TODO_TOOLS check' };
  const models = sets[sets.length - 1][1].split(',').map((s) => s.replace(/"/g, '')).filter(Boolean);
  return { models };
}

/** The models on the list from major version 5 on: the ones a work plan is written for. */
function currentOn(models) {
  return models.filter((m) => { const v = CURRENT.exec(m); return v && Number(v[1]) >= 5; });
}

function main(file) {
  const r = gateOf(fs.readFileSync(file));
  if (r.error) {
    console.log(`to-do tools: ${r.error}; read the CLI by hand to see which models get them`);
    return 1;
  }
  const open = currentOn(r.models);
  if (open.length) {
    console.log(`to-do tools: Claude Code gives its own to-do tools to ${open.join(', ')} again, beside a work plan`);
    return 1;
  }
  console.log(`to-do tools: no 5.x model among the ${r.models.length} on the list`);
  return 0;
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('usage: node test/todo-gate.js <path to resources/native-binary/claude>');
    process.exit(2);
  }
  process.exit(main(process.argv[2]));
}

module.exports = { gateOf, currentOn, main };

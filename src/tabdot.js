// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A coloured dot after the title of a Claude Code tab, repeating the dot Claude Code puts on the tab's icon.
 *
 * Claude Code marks two states on the icon: a blue dot while it waits for you - a permission to grant or a question to
 * answer - and an orange one when the conversation finished while nobody was looking. Both sit on the orange logo and
 * the orange one is the logo's own colour, so they are hard to see. The editor's own sign for "this tab needs you" is a
 * dot beside the title, as an unsaved file shows; a webview panel has no way to ask for that one, so the dot goes into
 * the title text. Title text takes no colour of its own, so the dot is a coloured emoji: the only characters that bring
 * their colour with them.
 *
 * The patched host calls this each time it picks the tab's icon - which is each time the state behind it can change -
 * with the state it picked. The title the host set last is the base: a dot of ours is taken off before deciding again.
 */
const MARKS = { pending: ' \u{1F535}', done: ' \u{1F7E0}' };
// Taken off as well as added, so a title written by an earlier build of this does not keep its dot.
const ALL = [MARKS.pending, MARKS.done, ' \u25CF'];

function withDot(title, state, on) {
  let text = String(title == null ? '' : title);
  for (const mark of ALL) if (text.endsWith(mark)) { text = text.slice(0, -mark.length); break; }
  return on && MARKS[state] ? text + MARKS[state] : text;
}

module.exports = { MARKS, withDot };

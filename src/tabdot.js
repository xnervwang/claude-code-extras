// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A coloured mark after the title of a Claude Code tab: the dot Claude Code puts on the tab's icon, or green while a
 * turn runs, which the icon does not show.
 *
 * Claude Code marks two states on the icon: a blue dot while it waits for you - a permission to grant or a question to
 * answer - and an orange one when the conversation finished while nobody was looking. Both sit on the orange logo and
 * the orange one is the logo's own colour, so they are hard to see. The editor's own sign for "this tab needs you" is a
 * dot beside the title, as an unsaved file shows; a webview panel has no way to ask for that one, so the dot goes into
 * the title text. Title text takes no colour of its own, so the mark is a coloured emoji: the only characters that bring
 * their colour with them.
 *
 * The patched host calls this each time it picks the tab's icon - which is each time the state behind it can change -
 * with the icon key it picked ('pending', 'done' or 'plain') and the session state ('idle', 'running' or
 * 'waiting_input'). The title the host set last is the base: a dot of ours is taken off before deciding again.
 */
// The small blue and small orange diamonds: one pair in two colours, and smaller than the circles, which fill a whole
// line of text next to a title. There is no green diamond, so running takes the green book.
const MARKS = { pending: ' \u{1F539}', done: ' \u{1F538}', running: ' \u{1F4D7}' };
// Taken off as well as added, so a title written by an earlier build of this does not keep its mark.
const ALL = [MARKS.pending, MARKS.done, MARKS.running, ' \u{1F7E2}', ' \u{1F535}', ' \u{1F7E0}', ' \u25CF'];

function markFor(icon, run) {
  if (icon === 'pending') return 'pending';
  return run === 'running' ? 'running' : icon;
}

function withDot(title, state, on) {
  let text = String(title == null ? '' : title);
  for (const mark of ALL) if (text.endsWith(mark)) { text = text.slice(0, -mark.length); break; }
  return on && MARKS[state] ? text + MARKS[state] : text;
}

module.exports = { MARKS, markFor, withDot };

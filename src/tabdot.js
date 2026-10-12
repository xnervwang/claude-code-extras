// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A dot after the title of a Claude Code tab whose conversation finished while nobody was looking.
 *
 * Claude Code already marks that state, on the tab's icon: a dot in the logo's own orange, drawn on the orange logo, so
 * it is hard to see. The editor's own sign for "this tab holds something you have not dealt with yet" is a dot beside the
 * title, as an unsaved file shows; a webview panel has no way to ask for that one, so the dot goes into the title text.
 *
 * The patched host calls this each time it picks the tab's icon - which is each time the state behind it can change -
 * with the state it picked. The title the host set last is the base: a dot of ours is taken off before deciding again.
 */
const DOT = ' \u25CF';

function withDot(title, state, on) {
  const text = String(title == null ? '' : title);
  const bare = text.endsWith(DOT) ? text.slice(0, -DOT.length) : text;
  return on && state === 'done' ? bare + DOT : bare;
}

module.exports = { DOT, withDot };

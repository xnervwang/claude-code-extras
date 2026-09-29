// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Choosing which shape of an edit fits the build in front of us.
 *
 * An edit anchors on a shape rather than on a name, because the bundle is minified and every name in it changes from
 * one build to the next. Claude Code also reshapes the code an edit anchors on, without notice and often.
 *
 * Where the old and the new shape share a stable substring, widening the single pattern covers both, and that is the
 * cheaper answer. Where they do not, the alternative belongs here as a second shape, because the remaining options are
 * both bad: a pattern loose enough to match both usually matches a third place as well, which fails the
 * matches-exactly-once rule and refuses the build outright; and picking one shape abandons every build that still
 * carries the other.
 *
 * Shapes are listed most current first and tried in order. Exactly one of them must match exactly once. Nothing is
 * written unless every edit found its shape - a half-patched bundle is worse than an unpatched one, since the panel
 * would then be neither what Claude Code shipped nor what this extension expects.
 *
 * Both patch targets share this file, so that rule is stated once rather than copied.
 */

/** An edit's alternative shapes. A single-shape edit is written inline without the wrapper, and is the common case. */
function shapesOf(edit) {
  return edit.shapes || [{ re: edit.re, to: edit.to, note: edit.note }];
}

/** The one shape this source matches exactly once, or an error saying what each shape did. */
function pickShape(src, edit) {
  const shapes = shapesOf(edit);
  const counts = [];
  for (let i = 0; i < shapes.length; i++) {
    const n = (src.match(shapes[i].re) || []).length;
    if (n === 1) return { shape: shapes[i], index: i, note: shapes[i].note, total: shapes.length };
    counts.push(n);
  }
  const detail = counts.length === 1
    ? `matched ${counts[0]} times (expected 1)`
    : `matched ${counts.join(' / ')} times across its ${counts.length} known shapes (expected one of them to match once)`;
  return { error: `"${edit.name}" ${detail} - this Claude Code build is not supported yet` };
}

/** Apply every edit or none. Returns { out, chosen } or { error }; `chosen` records which shape each edit used. */
function applyEdits(src, edits) {
  let out = src;
  const chosen = [];
  for (const e of edits) {
    const picked = pickShape(out, e);
    if (picked.error) return { error: picked.error };
    out = out.replace(picked.shape.re, picked.shape.to);
    chosen.push({ name: e.name, index: picked.index, note: picked.note, total: picked.total });
  }
  return { out, chosen };
}

module.exports = { shapesOf, pickShape, applyEdits };

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Making the always-visible usage meter read correctly.
// Fragment of the in-page script - see README.md in this folder.

  // The meter's artwork has three fixed states - an arc covering half the circle, one covering three quarters, one
  // almost closed - because Claude Code only ever showed it below half remaining. Always visible it would read
  // half-full on an empty conversation and then jump between the three. Each state covers a known extent, so
  // trimming the drawn arc to (real figure / that extent) turns all three into one continuous reading.
  var meterExtent = function(used){ return used <= 50 ? 50 : used <= 75 ? 75 : 99; };
  var trimMeter = function(btn, used){
    var arc = btn.querySelector('svg path[stroke*="orange"]') || btn.querySelector('svg path:last-of-type');
    if (!arc || typeof arc.getTotalLength !== 'function') return;
    var len = 0;
    try { len = arc.getTotalLength(); } catch (e) { return; }
    if (!(len > 0)) return;
    var shown = Math.max(0, Math.min(1, used / meterExtent(used))) * len;
    var want = shown.toFixed(2) + ' ' + (len + 1).toFixed(2);
    if (arc.style.strokeDasharray !== want) arc.style.strokeDasharray = want;
  };
  // The figure the meter was handed, taken from the meter itself rather than worked out again from the session's token
  // counts. Two reasons, and the first is a defect this replaced: the session object is reachable only through a
  // message, so on a conversation with none the arc was never trimmed and read as the full extent of its artwork.
  // The second is that recomputing it means holding a copy of the panel's own denominator - the window less the
  // reserved output less the margin kept for an auto-compact - which can be changed upstream without notice.
  var meterUsed = function(btn){
    for (var f = fiber(btn), i = 0; f && i < 12; f = f.return, i++) {
      var pr = f.memoizedProps;
      if (pr && typeof pr.percentageUsed === 'number') return pr.percentageUsed;
    }
    // The same figure, rounded, is on the button for screen readers.
    var m = /(\d+)%/.exec(btn.getAttribute('aria-label') || '');
    return m ? Number(m[1]) : null;
  };
  /*
   * The window size a reopened conversation is missing, filled in until the panel learns the real one.
   *
   * Reopened, the panel replays the transcript and recovers the token count, but the window only ever arrives on the
   * message that closes a turn, and that message is not written to the transcript. So until the first reply finishes the
   * meter has no denominator and draws nothing, and the per-reply figure has no share to show. This writes only while
   * the panel has no window of its own, and the first real one replaces it.
   *
   * Two sizes, told apart by the [1m] marker on the model that was picked. A table like that goes stale without saying
   * so; it is acceptable here only because it is shown until the first turn closes and no longer. Over 200,000 tokens
   * already settles it whatever the model says: a standard window cannot hold that many.
   *
   * The reserved output is filled too. The meter divides by the window less min(reserve, cap) less a margin, so a reserve
   * left at 0 would read low and then jump when the first reply lands. Any value at or above the cap gives the panel's
   * own figure without this file holding a copy of the cap, and nothing else in the panel reads that field.
   *
   * Nothing is written while the token count is 0. If the replay did not recover it, a meter reading 0% on a
   * conversation that may hold most of a million tokens says something false, which is worse than saying nothing.
   *
   * The cost is NOT restored, on purpose. The only cost figure on disk is the transcript's cost-state row, and the panel
   * is never sent that row - neither the panel bundle nor the host bundle mentions it. Restoring it would mean this
   * extension's host reading the transcript and carrying the figure to the page through the shared live stylesheet,
   * keyed by session: the channel whose races between windows once made settings flicker. That is a lot of machinery
   * for a number that appears by itself as soon as the first reply closes its turn.
   */
  var STANDARD_WINDOW = 200000, LARGE_WINDOW = 1000000;
  var fillWindow = function(){
    if (!isOn() || (isOff('contextMeter') && isOff('contextShare'))) return;
    var sig = sessionRef && sessionRef.usageData, u = sig && sig.value;
    if (!u || u.contextWindow > 0 || !(u.totalTokens > 0)) return;
    var info = sessionRef.currentModelInfo && sessionRef.currentModelInfo.value;
    var pick = info && typeof info.resolvedModel === 'string' ? info.resolvedModel : '';
    var win = u.totalTokens > STANDARD_WINDOW || /\[1m\]$/i.test(pick) ? LARGE_WINDOW : pick ? STANDARD_WINDOW : 0;
    if (!win) return;
    sig.value = Object.assign({}, u, {
      contextWindow: win,
      maxOutputTokens: u.maxOutputTokens > 0 ? u.maxOutputTokens : Number.MAX_SAFE_INTEGER,
    });
  };
  // Outline the context meter once the remaining share gets thin, ahead of an auto-compact.
  var LOW_AT = 15;
  var markCtxLow = function(){
    if (isOff('contextMeter')) return;
    var btn = document.querySelector('button[class*="usageButtonV2"]');
    if (!btn) return;
    var used = meterUsed(btn);
    if (used === null) return;
    var left = 100 - used;
    try { trimMeter(btn, used); } catch (e) {}
    if (left <= LOW_AT) {
      btn.style.outline = '1px solid var(--vscode-editorWarning-foreground, #cca700)';
      btn.style.outlineOffset = '1px';
      btn.style.borderRadius = '4px';
    } else if (btn.style.outline) {
      btn.style.outline = '';
    }
  };

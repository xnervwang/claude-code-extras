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
  // Outline the context meter once the remaining share gets thin, ahead of an auto-compact.
  var LOW_AT = 15;
  var markCtxLow = function(){
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

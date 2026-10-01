// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Per-reply duration, context share and estimated spend.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * The model a reply names, with the 1M marker put back when it is the 1M model that answered.
   *
   * On Bedrock a reply never carries the marker, even when the 1M model is the one answering: 1M context is a request
   * header there, not part of the model's name, so every reply says `claude-opus-5-5` whichever of the two was picked.
   * Whether it is the 1M model is therefore a fact about the pick, and it is taken from there - but only when the reply's
   * model IS the one picked, compared without the 1M marker or the provider prefix. A reply from some other model is shown
   * exactly as it came, since a model other than the one chosen is what this part of the line exists to show.
   *
   * The panel's own model pill had the same fault for the same reason and is fixed by an edit in src/webview.js.
   */
  var withOneMillion = function(served, session){
    var info = session && session.currentModelInfo && session.currentModelInfo.value;
    var pick = info && typeof info.resolvedModel === 'string' ? info.resolvedModel : '';
    if (!/\[1m\]$/i.test(pick) || /\[1m\]$/i.test(served)) return served;
    var base = function(x){ return x.replace(/\[1m\]$/i, '').replace(/^(?:[a-z]+\.)?anthropic\./i, ''); };
    return base(pick) === base(served) ? served + '[1m]' : served;
  };

  // Context share and estimated spend as they stood when a reply settled. Keyed by the message object
  // in a WeakMap, so entries disappear when the message itself is collected - no growing table.
  var atMsg = new WeakMap();
  var snapNow = function(){
    var u = sessionRef && sessionRef.usageData && sessionRef.usageData.value;
    if (!u) return '';
    var out = '';
    /*
     * Share of the WHOLE context window, which is what /context reports - deliberately not the panel meter's figure.
     *
     * The meter divides by the room left before an auto-compact (the window less the reserved output less a fixed
     * margin), and it already shows that on hover, so repeating it here would spend characters on a number the reader
     * can already see. What is not on screen anywhere is plain occupancy, and the label says "ctx", which reads as
     * occupancy. Matching /context also means two figures the reader compares cannot disagree.
     *
     * A side effect worth having: neither the reserved-output figure nor that fixed margin enters this any more, so an
     * upstream change to either cannot quietly skew it. And the share of a full window cannot exceed 100, so the
     * clamp that used to hide how far past the compaction point a conversation had gone is gone with it.
     */
    var win = u.contextWindow || 0;
    // Short labels on purpose: this string is prepended to every reply's first line, so each extra
    // character comes out of the body width. Spell them out here if you prefer the long form.
    if (win > 0 && !isOff('contextShare')) out += 'ctx ' + Math.round(u.totalTokens / win * 100) + '%';
    if (typeof u.totalCost === 'number' && u.totalCost > 0 && !isOff('cost')) {
      var c = u.totalCost < 1 ? u.totalCost.toFixed(3) : u.totalCost.toFixed(2);
      out += (out ? ' ' + String.fromCharCode(183) + ' ' : '') + 'cost $' + c;
    }
    var who = [];
    if (isOff('modelName')) who.length = 0; else {
    var mdl = sessionRef.lastServedModel && sessionRef.lastServedModel.value;
    if (!mdl) mdl = sessionRef.currentMainLoopModel && sessionRef.currentMainLoopModel.value;
    if (typeof mdl === 'string' && mdl) who.push(withOneMillion(mdl, sessionRef).replace(/^claude-/, ''));
    var eff = sessionRef.effortLevel && sessionRef.effortLevel.value;
    if (typeof eff === 'string' && eff) who.push(eff);
    var fast = sessionRef.fastModeState && sessionRef.fastModeState.value;
    if (typeof fast === 'string' && fast !== 'off') who.push('fast');
    }
    if (who.length) out += (out ? ' ' + String.fromCharCode(183) + ' ' : '') + who.join(' ');
    return out;
  };
  // The newest reply keeps refreshing; older ones stay frozen at the value they last showed, which
  // is the figure right after that turn closed.
  var statAt = function(m, live){
    if (!m) return '';
    if (live) {
      var s = snapNow();
      if (s) atMsg.set(m, s);
      return s;
    }
    var v = atMsg.get(m);
    if (v === undefined) { v = snapNow(); if (v) atMsg.set(m, v); }
    return v || '';
  };
  var dur = function(ms){
    if (!(ms > 0)) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var mi = Math.floor(s / 60), rs = s % 60;
    if (mi < 60) return mi + 'm' + (rs ? rs + 's' : '');
    return Math.floor(mi / 60) + 'h' + (mi % 60) + 'm';
  };
  // Binary search over the prompt timestamps gathered earlier in this same sweep: the latest prompt
  // at or before a reply is that turn's start. No lookup table is kept between sweeps.
  var turnStartFor = function(list, ts){
    var lo = 0, hi = list.length - 1, ans = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid] <= ts) { ans = list[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

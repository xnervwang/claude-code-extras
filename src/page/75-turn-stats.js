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

  // Each reply's context share and estimated cost, saved when it settles. The two are stored separately so that each
  // can follow its own switch. A WeakMap keyed by the message object.
  var atMsg = new WeakMap();
  var figuresNow = function(){
    var u = sessionRef && sessionRef.usageData && sessionRef.usageData.value;
    if (!u) return null;
    var share = '', cost = '';
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
    if (win > 0) share = 'ctx ' + Math.round(u.totalTokens / win * 100) + '%';
    if (typeof u.totalCost === 'number' && u.totalCost > 0) {
      cost = 'cost $' + (u.totalCost < 1 ? u.totalCost.toFixed(3) : u.totalCost.toFixed(2));
    }
    return share || cost ? { share: share, cost: cost } : null;
  };
  var figuresText = function(f){
    if (!f) return '';
    var bits = [];
    if (f.share && !isOff('contextShare')) bits.push(f.share);
    if (f.cost && !isOff('cost')) bits.push(f.cost);
    return bits.join(' ' + String.fromCharCode(183) + ' ');
  };
  /*
   * Which model answered and with what effort, taken from the reply itself: the model the panel recorded on the
   * message, and the effort the extension read from the transcript (76-effort.js), which the sweep hands in. Neither
   * comes from the session's current values, which describe the next request rather than any reply already made -
   * that is what put whatever the menu said at the moment of looking under every reply of a conversation, history
   * included. Fast mode is still the session's own value; nothing records it per reply.
   */
  var whoFor = function(m, effort){
    if (isOff('modelName') || typeof m.model !== 'string' || !m.model) return '';
    var who = [withOneMillion(m.model, sessionRef).replace(/^claude-/, '')];
    if (effort) who.push(effort);
    var fast = sessionRef && sessionRef.fastModeState && sessionRef.fastModeState.value;
    if (typeof fast === 'string' && fast !== 'off') who.push('fast');
    return who.join(' ');
  };
  // The newest reply keeps refreshing its figures; older ones stay frozen at what they last showed, which is the figure
  // right after that turn closed.
  //
  // A reply this page never saw as the newest closed its turn before the page was loaded - the history of a reopened
  // conversation. Its own share and spend were never seen, and the current ones are not its, so it gets its model and
  // effort and no figures. Handing it the current figures would put the same total under every reply in the history.
  var statAt = function(m, live, effort){
    if (!m) return '';
    var fig = atMsg.get(m);
    if (live) { fig = figuresNow(); if (fig) atMsg.set(m, fig); }
    var text = figuresText(fig), who = whoFor(m, effort);
    return text && who ? text + ' ' + String.fromCharCode(183) + ' ' + who : (text || who || '');
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

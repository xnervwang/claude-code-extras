// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The latest tool call at the end of the working line, while Claude Code's Focus view has the tool calls folded away.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * With the tool calls folded away, the panel's working indicator is the only sign that a turn is alive, and it
   * animates the same whether a command is pouring out output or nothing has happened for ten minutes. So while the
   * indicator is up, the end of its line carries the latest tool call: which tool, whether it has come back, and how
   * long ago - the one thing that tells a busy turn from a stuck one. Focus view names the call it folds, but not when it
   * started or finished.
   *
   * The figures are read off the session's own message list, not off the page. Focus view mounts a folded group's
   * tool calls only when it is opened, so the blocks the sweep reads are not there to read; the list holds every call,
   * and the time each result came back is recorded on the call by the patch that records it for the reply blocks.
   *
   * The label is an element of its own on the body, placed against the indicator's row, so nothing goes inside a node
   * the panel owns. It sits at the right end of that row rather than after the indicator's words: the panel pads the
   * verb with ordinary spaces, which collapse, so the words change width with every new verb and a label placed after
   * them would jump.
   */
  var TOOLCLOCK = null, workingRow = null, workingBox = null;
  // A turn with a few hundred tool calls is a few hundred messages; past this many the walk stops and says what it saw.
  var TOOL_WALK_MAX = 4000;

  // A prompt opens a turn: a message of the main thread's user side that carries something other than tool results.
  var isPrompt = function(m){
    if (!m || m.type !== 'user' || agentOf(m) || !Array.isArray(m.content)) return false;
    for (var i = 0; i < m.content.length; i++) {
      var c = m.content[i] && m.content[i].content;
      if (c && c.type !== 'tool_result') return true;
    }
    return false;
  };
  var resultBack = function(b){
    if (typeof b.cceResultAt === 'number') return true;
    var r = b.toolResult;
    return !!(r && typeof r === 'object' && 'value' in r && r.value !== undefined);
  };

  /* The current turn's calls, newest message first, stopping at the prompt that opened it. A call with no result yet
     is running: everything before that prompt belongs to an earlier turn, so a call there that never came back was cut
     short, and the walk never reaches it. Only `tool_use` counts as open: a server tool's result arrives as a block of
     its own, and the time it came back is not recorded on the call. */
  var toolState = function(msgs){
    var s = { at: 0, name: '', doneAt: 0, open: 0, openAt: 0, turnAt: 0 };
    if (!Array.isArray(msgs)) return s;
    var stop = Math.max(0, msgs.length - TOOL_WALK_MAX);
    for (var i = msgs.length - 1; i >= stop; i--) {
      var m = msgs[i];
      if (!m) continue;
      if (isPrompt(m)) { if (typeof m.timestamp === 'number') s.turnAt = m.timestamp; break; }
      if (m.type !== 'assistant' || typeof m.timestamp !== 'number' || !Array.isArray(m.content)) continue;
      for (var k = 0; k < m.content.length; k++) {
        var b = m.content[k], c = b && b.content;
        if (!c || (c.type !== 'tool_use' && c.type !== 'server_tool_use')) continue;
        if (m.timestamp >= s.at) { s.at = m.timestamp; s.name = c.name || 'tool'; }
        if (typeof b.cceResultAt === 'number') { if (b.cceResultAt > s.doneAt) s.doneAt = b.cceResultAt; }
        else if (c.type === 'tool_use' && !resultBack(b)) {
          s.open++;
          if (!s.openAt || m.timestamp < s.openAt) s.openAt = m.timestamp;
        }
      }
    }
    return s;
  };

  // Two lengths, because a narrow panel has room for one only: the absolute time is what goes first.
  var toolClockText = function(s, now, short){
    var ago = function(t){ return dur(now - t) || '0s'; };
    if (s.open > 0) {
      var what = s.open > 1 ? s.open + ' tools' : s.name;
      return short ? what + ' ' + ago(s.openAt) : what + ' running for ' + ago(s.openAt) + ' (since ' + fmt(s.openAt) + ')';
    }
    if (s.at && s.at >= s.turnAt) {
      var last = Math.max(s.at, s.doneAt);
      return short ? 'last tool ' + ago(last) + ' ago' : 'last tool ' + s.name + ' finished ' + ago(last) + ' ago (' + fmt(last) + ')';
    }
    if (short) return 'no tool yet';
    return 'no tool call yet this turn' + (s.turnAt ? ' (' + ago(s.turnAt) + ' since your message)' : '');
  };

  // The indicator names itself in words only a screen reader hears. Those words are fixed, where its class names are
  // hashed afresh by every build; the row around it is matched by name pattern, as the rail rows are.
  var WORKING = /^(Claude is working|Compacting conversation)$/;
  var boxIn = function(row){
    var hs = row.querySelectorAll('[class*="visuallyHidden_"]');
    for (var k = 0; k < hs.length; k++) if (WORKING.test(String(hs[k].textContent || '').trim())) return hs[k].parentElement;
    return null;
  };
  /*
   * The row is kept once found. The panel keeps it mounted and mounts only the indicator inside it afresh each turn, so
   * a new turn is looked for in that one row first. Searching the page is the costly part - it reads every element - so
   * it happens only when the indicator is not in that row, and then at most every few seconds. A search that finds
   * nothing keeps the row: a turn that has only just started has not drawn its indicator yet, and the next tick finds
   * it there without waiting for another search.
   */
  var lookedAt = 0;
  var findWorking = function(){
    if (workingRow && !workingRow.isConnected) workingRow = workingBox = null;
    if (workingRow) {
      if (!(workingBox && workingBox.isConnected && workingRow.contains(workingBox))) workingBox = boxIn(workingRow);
      if (workingBox) return workingRow;
    }
    var now = Date.now();
    if (now - lookedAt < 3000) return null;
    lookedAt = now;
    var rows = document.querySelectorAll('[class*="spinnerRow_"]');
    for (var i = 0; i < rows.length; i++) {
      var box = boxIn(rows[i]);
      if (box) { workingRow = rows[i]; workingBox = box; return workingRow; }
    }
    return null;
  };

  // The long form and the short form, each in a span of the label: both are written and then both measured, so a tick
  // costs one layout however many forms it tries, and only the one that fits is shown.
  var clockSpans = null, clockTexts = ['', ''], clockW = [0, 0], clockH = 0, clockQueued = false;
  var hideToolClock = function(){ if (TOOLCLOCK) setStyle(TOOLCLOCK, 'display', 'none'); };
  var inView = function(r){ return !!r && r.width > 0 && r.bottom >= 0 && r.top <= (window.innerHeight || 0); };
  // A scroll moves the row, and nothing else about the label changes: one placement a frame, with the size already known.
  var followScroll = function(){
    if (clockQueued || !TOOLCLOCK || TOOLCLOCK.style.display !== 'block') return;
    clockQueued = true;
    requestAnimationFrame(function(){
      clockQueued = false;
      var r = workingRow && workingRow.isConnected ? workingRow.getBoundingClientRect() : null;
      if (!inView(r)) { hideToolClock(); return; }
      setStyle(TOOLCLOCK, 'top', Math.round(r.top + (r.height - clockH) / 2) + 'px');
    });
  };
  var setClockTexts = function(long, short){
    if (long === clockTexts[0] && short === clockTexts[1]) return;
    setStyle(clockSpans[0], 'display', ''); setStyle(clockSpans[1], 'display', '');
    clockSpans[0].textContent = clockTexts[0] = long;
    clockSpans[1].textContent = clockTexts[1] = short;
    clockW = [clockSpans[0].offsetWidth, clockSpans[1].offsetWidth];
    clockH = TOOLCLOCK.offsetHeight;
  };
  var paintToolClock = function(){
    // Signals first: the panel draws its indicator only while visibly busy and not waiting on a permission prompt, and
    // outside that there is nothing to label and no reason to read the page at all. With the tool calls on screen the
    // label would repeat what is already there, so it waits for Focus view.
    if (isOff('footerPlainView') || !sigOn('visiblyBusy') || sigLen('permissionRequests') > 0) { hideToolClock(); return; }
    var ctx = panelContext();
    if (!ctx || !ctx.focusViewEnabled) { hideToolClock(); return; }
    var row = findWorking();
    var r = row ? row.getBoundingClientRect() : null;
    if (!inView(r)) { hideToolClock(); return; }
    var list = sessionRef && sessionRef.messages && sessionRef.messages.value;
    if (!TOOLCLOCK || !TOOLCLOCK.isConnected) {
      TOOLCLOCK = document.createElement('div');
      TOOLCLOCK.setAttribute('data-cce-toolclock', '1');
      var s = TOOLCLOCK.style;
      s.position = 'fixed'; s.zIndex = '30'; s.pointerEvents = 'none'; s.whiteSpace = 'nowrap';
      s.fontSize = '11px'; s.opacity = '0.8'; s.color = 'var(--vscode-descriptionForeground, #9d9d9d)';
      clockSpans = [document.createElement('span'), document.createElement('span')];
      TOOLCLOCK.appendChild(clockSpans[0]); TOOLCLOCK.appendChild(clockSpans[1]);
      document.body.appendChild(TOOLCLOCK);
      clockTexts = ['', ''];
      try { window.addEventListener('scroll', followScroll, { capture: true, passive: true }); } catch (e) {}
    }
    setStyle(TOOLCLOCK, 'display', 'block');
    var state = toolState(list), floor = workingBox.getBoundingClientRect().right + 12, now = Date.now();
    setClockTexts(toolClockText(state, now, false), toolClockText(state, now, true));
    for (var pass = 0; pass < 2; pass++) {
      var left = Math.round(r.right - 8 - clockW[pass]);
      if (left >= floor) {
        setStyle(clockSpans[0], 'display', pass === 0 ? '' : 'none');
        setStyle(clockSpans[1], 'display', pass === 1 ? '' : 'none');
        setStyle(TOOLCLOCK, 'left', left + 'px');
        setStyle(TOOLCLOCK, 'top', Math.round(r.top + (r.height - clockH) / 2) + 'px');
        return;
      }
    }
    // Not even the short form fits beside the indicator's words; covering them would be worse than saying nothing.
    hideToolClock();
  };

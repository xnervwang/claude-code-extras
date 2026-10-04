// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// A toggle that leaves only the conversation: your questions and the replies, without the thinking and the tool calls.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * This is the second of two independent filters, and it stays independent by writing somewhere else.
   *
   * The view filter decides WHOSE messages are shown and writes `display` on the message element. This one decides WHICH
   * KINDS of block are shown, and a block is a child of that element - so the two never write the same property of the
   * same node, and hiding a message still hides everything inside it whatever this says.
   *
   * It hides by stylesheet rather than by walking the blocks. Each block is labelled once, when the sweep derives it
   * anyway; the toggle then edits one rule. Walking instead would mean visiting every block of every message on every
   * sweep - the one cost this extension is not allowed to have, since it grows with the length of the conversation - and
   * it would also miss the messages the sweep has already settled and stopped looking at.
   */
  var KIND_ATTR = 'data-cce-kind';
  var PLAIN_KEY = 'cce.plain';
  // What a conversation is: what was said. Thinking is the reply being composed rather than the reply, and a tool call
  // is the work behind it. `image` stays, because an image someone pasted is part of what they said.
  var NOT_PLAIN = ['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'tool_result'];
  var PLAINBTN = null, plainStyle = null;

  var plainOn = function(){
    try { return window.localStorage.getItem(PLAIN_KEY) === '1'; } catch (e) { return false; }
  };
  var setPlain = function(on){
    try { window.localStorage.setItem(PLAIN_KEY, on ? '1' : '0'); } catch (e) {}
  };

  // Labelling is free: the sweep has already read the block's type to decide what to write on it.
  var applyKind = function(el, type){
    if (isOff('footerPlainView')) return;
    if (typeof type !== 'string' || !type) return;
    if (el.getAttribute(KIND_ATTR) !== type) el.setAttribute(KIND_ATTR, type);
  };

  /*
   * One rule, edited in place. `!important` because the panel sets `display` on some of these blocks itself, and a
   * filter that loses to the thing it is filtering is not a filter.
   *
   * The second half of the rule is about the rail. The dot and the line segment beside a row are the ::before and
   * ::after of the row the panel marks with a `timelineMessage_` class - tool-call headers and fold rows carry it - so
   * hiding a block INSIDE such a row leaves the row itself behind at collapsed height, painting a dot with nothing next
   * to it. The row has to go too.
   *
   * It goes only when it has nothing left worth showing: a row holding a text block as well keeps its place, because
   * there is still something to read there and the dot belongs to it. The class is matched by name pattern rather than
   * in full - the panel's build hashes the suffix, and the same technique is how the panel's own message classes are
   * matched elsewhere in this script.
   */
  var RAIL = '[class*="timelineMessage_"]';
  var paintPlainRule = function(){
    if (!plainStyle) {
      plainStyle = document.createElement('style');
      plainStyle.setAttribute('data-cce-plain', '1');
      (document.head || document.documentElement).appendChild(plainStyle);
    }
    if (!plainOn()) { plainStyle.textContent = ''; return; }
    var sel = [], keep = ':not(:has([' + KIND_ATTR + '="text"]))';
    for (var i = 0; i < NOT_PLAIN.length; i++) {
      var k = '[' + KIND_ATTR + '="' + NOT_PLAIN[i] + '"]';
      sel.push(k);
      sel.push(RAIL + ':has(' + k + ')' + keep);
    }
    plainStyle.textContent = sel.join(',') + '{display:none !important}';
  };

  /*
   * The two states are told apart by the shape of the icon, not by how bright it is.
   *
   * An eye that is open or shut says which one you are in; a single icon at two opacities says it only to someone who
   * remembers what the other one looked like. A speech balloon was worse than either: in a panel that is nothing but a
   * conversation, "conversation" does not pick anything out.
   *
   * The glyphs come from the icon font the panel already embeds, so they follow the theme's colour and the button's own
   * size like every other icon in the editor. The code points were read out of that font's own glyph table rather than
   * copied from a list - a wrong one draws an empty box and nothing else says why.
   */
  /*
   * Drawn here rather than taken from the icon font, which produced an empty box: the family never took effect on this
   * button, and whatever it fell back to has nothing at that code point. The class these buttons copy already sizes an
   * `svg` child, which says what this row is built to hold - so drawing one is what the panel's own controls do, and it
   * cannot fail the way a missing glyph does.
   *
   * Two arrows facing each other mean folded, facing apart mean open. That pair is the editor's own sign for collapsing
   * and expanding detail, so it needs no explaining, and it says the right thing: what this hides is still there. The
   * two it replaced said the wrong thing - a speech balloon picks nothing out in a panel that is all conversation, and
   * an eye says only that something is hidden, not what.
   */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var foldIcon = function(folded){
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    /* Sized in the style attribute rather than by the width and height attributes, because the class this button copies
       carries `svg{width:26px;height:26px}` - the size of the button itself - and a presentation attribute loses to a
       rule. Left to that rule the icon fills the button edge to edge with no room around it. */
    svg.style.width = '15px'; svg.style.height = '15px';
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var add = function(d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    };
    add('M2 8h12');
    // Pointing in towards the line when folded, away from it when not: the line stays put so only the arrows change.
    if (folded) { add('M5 3.4l3 2.6 3-2.6'); add('M5 12.6l3-2.6 3 2.6'); }
    else { add('M5 5.6l3-2.6 3 2.6'); add('M5 10.4l3 2.6 3-2.6'); }
    return svg;
  };
  var paintPlain = function(){
    if (!PLAINBTN) return;
    var on = plainOn();
    // Replaced only where the state turned over, so a repaint on the timer does not rebuild the icon twice a second.
    var want = on ? 'folded' : 'open';
    if (PLAINBTN.getAttribute('data-cce-fold') !== want) {
      PLAINBTN.setAttribute('data-cce-fold', want);
      while (PLAINBTN.firstChild) PLAINBTN.removeChild(PLAINBTN.firstChild);
      PLAINBTN.appendChild(foldIcon(on));
    }
    setStyle(PLAINBTN, 'opacity', on ? '1' : '0.6');
    setLabel(PLAINBTN, on
      ? 'Showing the conversation only - click to bring back thinking and tool calls'
      : 'Show the conversation only: your messages and the replies, without thinking or tool calls');
  };

  // Same anchor as the other footer controls: the send button's previous sibling is the permission-mode selector, and
  // React may replace that row, so this is re-checked on the timer rather than wired once.
  var ensurePlainControl = function(){
    if (isOff('footerPlainView')) return;
    paintPlainRule();
    if (PLAINBTN && PLAINBTN.isConnected) { paintPlain(); return; }
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    PLAINBTN = document.createElement('button');
    PLAINBTN.type = 'button';
    PLAINBTN.setAttribute('data-cce-plain-btn', '1');
    var proto = document.querySelector('button[class*="menuButton"]');
    if (proto) PLAINBTN.className = proto.className;
    else {
      PLAINBTN.style.background = 'transparent';
      PLAINBTN.style.border = 'none';
      PLAINBTN.style.color = 'var(--vscode-foreground, #ccc)';
      PLAINBTN.style.cursor = 'pointer';
    }
    PLAINBTN.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      setPlain(!plainOn());
      paintPlainRule();
      paintPlain();
    });
    mode.parentElement.insertBefore(PLAINBTN, mode);
    paintPlain();
  };

  /*
   * With the tool calls folded away, the panel's working indicator is the only sign that a turn is alive, and it
   * animates the same whether a command is pouring out output or nothing has happened for ten minutes. So while the
   * indicator is up, the end of its line carries the latest tool call: which tool, whether it has come back, and how
   * long ago - the one thing that tells a busy turn from a stuck one.
   *
   * The figures are gathered by the sweep, which reads every tool block of the newest replies anyway; this keeps only
   * the latest. The label is an element of its own on the body, placed against the indicator's row, so nothing goes
   * inside a node the panel owns. It sits at the right end of that row rather than after the indicator's words: the
   * panel pads the verb with ordinary spaces, which collapse, so the words change width with every new verb and a
   * label placed after them would jump.
   */
  var toolNext = null, toolNow = { at: 0, name: '', doneAt: 0, open: 0, openAt: 0, turnAt: 0 };
  var TOOLCLOCK = null, workingRow = null, workingBox = null;

  /* Gathered whether or not the view is folded right now. A sweep runs only when the page changes, so a fold pressed
     halfway through a quiet tool call would otherwise show no call at all until something else moved; and the cost is a
     few reads per tool block of the newest replies, which the sweep is reading in any case. */
  var beginToolSweep = function(turnAt){
    toolNext = isOff('footerPlainView') ? null
      : { at: 0, name: '', doneAt: 0, open: 0, openAt: 0, turnAt: typeof turnAt === 'number' ? turnAt : 0 };
  };
  // A call is running when it belongs to this turn and has no result yet. One from an earlier turn without a result was
  // cut short, not running. Only `tool_use` counts as open: a server tool's result arrives as a block of its own, and
  // the time it came back is not recorded on the call.
  var noteTool = function(cx, type){
    if (!toolNext || !cx || !cx.message || !cx.block) return;
    var at = cx.message.timestamp, done = cx.block.cceResultAt;
    if (typeof at !== 'number') return;
    if (at >= toolNext.at) { toolNext.at = at; toolNext.name = (cx.block.content && cx.block.content.name) || 'tool'; }
    if (typeof done === 'number') { if (done > toolNext.doneAt) toolNext.doneAt = done; }
    else if (type === 'tool_use' && at >= toolNext.turnAt) {
      toolNext.open++;
      if (!toolNext.openAt || at < toolNext.openAt) toolNext.openAt = at;
    }
  };
  // The sweep reads only the newest replies in full, so a sweep that met no tool call, in a turn that has not changed,
  // keeps the figures it had rather than forgetting a call that has moved out of that window.
  var endToolSweep = function(){
    if (!toolNext) return;
    if (toolNext.at || toolNext.turnAt !== toolNow.turnAt) toolNow = toolNext;
    toolNext = null;
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
  // hashed afresh by every build; the row around it is matched by name pattern, as the rail rows are above.
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

  var clockText = '', clockW = 0, clockH = 0, clockQueued = false;
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
  var setClockText = function(text){
    if (text === clockText) return;
    TOOLCLOCK.textContent = clockText = text;
    clockW = TOOLCLOCK.offsetWidth; clockH = TOOLCLOCK.offsetHeight;
  };
  var paintToolClock = function(){
    // Signals first: the panel draws its indicator only while visibly busy and not waiting on a permission prompt, and
    // outside that there is nothing to label and no reason to read the page at all.
    if (isOff('footerPlainView') || !plainOn() || !sigOn('visiblyBusy') || sigLen('permissionRequests') > 0) {
      hideToolClock(); return;
    }
    var row = findWorking();
    var r = row ? row.getBoundingClientRect() : null;
    if (!inView(r)) { hideToolClock(); return; }
    if (!TOOLCLOCK || !TOOLCLOCK.isConnected) {
      TOOLCLOCK = document.createElement('div');
      TOOLCLOCK.setAttribute('data-cce-toolclock', '1');
      var s = TOOLCLOCK.style;
      s.position = 'fixed'; s.zIndex = '30'; s.pointerEvents = 'none'; s.whiteSpace = 'nowrap';
      s.fontSize = '11px'; s.opacity = '0.8'; s.color = 'var(--vscode-descriptionForeground, #9d9d9d)';
      document.body.appendChild(TOOLCLOCK);
      clockText = '';
      try { window.addEventListener('scroll', followScroll, { capture: true, passive: true }); } catch (e) {}
    }
    setStyle(TOOLCLOCK, 'display', 'block');
    var floor = workingBox.getBoundingClientRect().right + 12, now = Date.now();
    for (var pass = 0; pass < 2; pass++) {
      setClockText(toolClockText(toolNow, now, pass === 1));
      var left = Math.round(r.right - 8 - clockW);
      if (left >= floor) {
        setStyle(TOOLCLOCK, 'left', left + 'px');
        setStyle(TOOLCLOCK, 'top', Math.round(r.top + (r.height - clockH) / 2) + 'px');
        return;
      }
    }
    // Not even the short form fits beside the indicator's words; covering them would be worse than saying nothing.
    hideToolClock();
  };

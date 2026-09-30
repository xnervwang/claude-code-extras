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

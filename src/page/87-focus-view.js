// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// A footer button for Claude Code's own Focus view: your messages and the replies, with thinking and tool calls folded.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * The folding is Claude Code's, not this script's. Its Focus view hides the thinking and the tool calls, keeps each
   * fold one click away and names the tool that is running; what it does not have is a control in sight - it is reached
   * through the input's command menu, a command or a key chord. This is that control and nothing more.
   *
   * The state is Claude Code's setting, read and written through the object the panel's own menu item uses. So there is
   * one state per editor: every window, every tab and the sidebar show the same, and turning it on in one turns it on in
   * all of them. A choice kept in the page would be kept once per page origin, and the sidebar, the tabs and another
   * editor would each remember their own.
   *
   * A build of Claude Code without Focus view has no such object, and then there is no button.
   */
  var FOCUSBTN = null, focusCtx = null, focusLookedAt = 0;
  // A build without Focus view never has the object, so the walk to the root is not repeated on every tick.
  var FOCUS_LOOK_MS = 5000;

  /* The panel hands that object to its root and to many components under it as a `context` prop, so walking up from
     the send button reaches it. It lives as long as the page, so it is looked for until found and then kept. */
  var findFocusCtx = function(){
    if (focusCtx) return focusCtx;
    var now = Date.now();
    if (now - focusLookedAt < FOCUS_LOOK_MS) return null;
    var seed = document.querySelector(SEND);
    // Not drawn yet is not an answer; a walk that found nothing is.
    if (!seed) return null;
    focusLookedAt = now;
    for (var f = fiber(seed); f; f = f.return) {
      var pr = f.memoizedProps, c = pr && typeof pr === 'object' ? pr.context : null;
      if (c && typeof c === 'object' && typeof c.setFocusView === 'function' && 'focusViewEnabled' in c) {
        focusCtx = c;
        return c;
      }
    }
    return null;
  };

  /*
   * Two arrows facing each other mean folded, facing apart mean open: the editor's own sign for collapsing and expanding
   * detail, and it says the right thing - what is folded is still there. Drawn as an `svg` because the class these
   * buttons copy already sizes one, which is what the panel's own controls hold.
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

  // Both labels say first what is on screen now, then what a click does.
  var FOCUS_ON = 'Focus view is on: only your messages and the replies - click to show thinking and tool calls';
  var FOCUS_OFF = 'Showing thinking and tool calls - click for Focus view: only your messages and the replies';
  var paintFocus = function(on){
    // Replaced only where the state turned over, so a repaint on the timer does not rebuild the icon twice a second.
    var want = on ? 'folded' : 'open';
    if (FOCUSBTN.getAttribute('data-cce-fold') !== want) {
      FOCUSBTN.setAttribute('data-cce-fold', want);
      while (FOCUSBTN.firstChild) FOCUSBTN.removeChild(FOCUSBTN.firstChild);
      FOCUSBTN.appendChild(foldIcon(on));
    }
    setStyle(FOCUSBTN, 'opacity', on ? '1' : '0.6');
    setLabel(FOCUSBTN, on ? FOCUS_ON : FOCUS_OFF);
  };

  // Same anchor as the other footer controls: the send button's previous sibling is the permission-mode selector, and
  // React may replace that row, so this is re-checked on the timer rather than wired once.
  var ensureFocusControl = function(){
    if (isOff('footerPlainView')) return;
    var ctx = findFocusCtx();
    if (!ctx) return;
    if (FOCUSBTN && FOCUSBTN.isConnected) { paintFocus(!!ctx.focusViewEnabled); return; }
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    FOCUSBTN = document.createElement('button');
    FOCUSBTN.type = 'button';
    FOCUSBTN.setAttribute('data-cce-focus-btn', '1');
    var proto = document.querySelector('button[class*="menuButton"]');
    if (proto) FOCUSBTN.className = proto.className;
    else {
      FOCUSBTN.style.background = 'transparent';
      FOCUSBTN.style.border = 'none';
      FOCUSBTN.style.color = 'var(--vscode-foreground, #ccc)';
      FOCUSBTN.style.cursor = 'pointer';
    }
    FOCUSBTN.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      var c = findFocusCtx();
      if (!c) return;
      var next = !c.focusViewEnabled;
      // The panel updates its own copy of the setting before the editor has written it, so the repaint can follow.
      Promise.resolve(c.setFocusView(next)).catch(function(){}).then(function(){ paintFocus(!!c.focusViewEnabled); });
      paintFocus(next);
    });
    mode.parentElement.insertBefore(FOCUSBTN, mode);
    paintFocus(!!ctx.focusViewEnabled);
  };

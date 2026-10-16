// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The pin on each row of the session list, and when a pinned conversation was really last active.
// Fragment of the in-page script - see README.md in this folder.

  // The pin is rendered by the panel itself, through the element factory an edit hands over, so a throw here would take
  // the list down with it; every entry point returns a harmless value instead.
  //
  // The host hands the pins over in the live stylesheet, as [pinned ids, {id: [real time, time given]}, margin in days].
  // Without that property there are no pins to draw: pinning is off, or the stylesheet came from a host that would not
  // act on a click. A pin is rendered either way and hidden until the property arrives, because the list may well be
  // drawn before the stylesheet has loaded, and a row the list does not draw again would otherwise never get its pin.
  var PIN_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /* A time read back from a file can differ from the one written by the file system's rounding. */
  var PIN_SAME_MS = 2000;
  /* How long a click is shown before the host has answered through the stylesheet, which the page asks for every few
     seconds. Past this the stylesheet wins, so a click nobody acted on undoes itself rather than lying. */
  var PIN_WAIT_MS = 15000;
  var PIN_BODY = 'M9.75 3.75h4.5v5.25l3 4.5h-10.5l3-4.5z';
  var PIN_LINES = 'M8.25 3.75h7.5M12 13.5v6.75';
  /*
   * One pin on every row, in front of the status dot the panel draws for a conversation that is running or unread, so
   * the pins of all rows line up down the left edge. It shows its state and is what is clicked: hollow and in the
   * panel's muted colour while not pinned, about as bright as the time beside it so it can be found; filled and purple
   * once pinned. Purple because the dot already uses green, blue, orange and red for a conversation's state, and a pin
   * in one of those would read as one more state. Always there rather than only on hover, so a row never moves under
   * the pointer and the feature can be found without knowing it exists.
   */
  var PIN_ON = 'span[data-cce-pin][data-cce-pinned="1"]:not([data-cce-pin-off])';
  var PIN_CSS = 'span[data-cce-pin]{order:-1;flex:none;display:inline-flex;align-items:center;justify-content:center;'
    + 'width:18px;height:18px;margin:0 -2px;border-radius:4px;cursor:pointer;'
    + 'color:var(--app-secondary-foreground,currentColor);opacity:.65}'
    + 'span[data-cce-pin] svg{width:15px;height:15px}'
    + '[class*="sessionItem_"]:where(:hover,:focus-visible,:has(:focus-visible),[data-highlighted]) span[data-cce-pin]{opacity:.9}'
    + 'span[data-cce-pin]:hover,span[data-cce-pin]:focus-visible{opacity:1;color:var(--app-primary-foreground,currentColor);'
    + 'background:var(--app-ghost-button-hover-background,transparent)}'
    + PIN_ON + ',' + PIN_ON + ':hover{opacity:1;color:var(--vscode-charts-purple,#b180d7)}'
    + PIN_ON + ' [data-cce-pin-body]{fill:currentColor}'
    + 'span[data-cce-pin][data-cce-pin-off]{display:none !important}';
  var pinStyle = null;
  var pinsNow = function(){
    if (pinsCache !== null) return pinsCache;
    var d = readProp('--cce-pins'), out = false;
    if (d && d.length === 3 && Array.isArray(d[0])) {
      out = { pinned: {}, times: d[1] && typeof d[1] === 'object' ? d[1] : {}, margin: Number(d[2]) || 0 };
      for (var i = 0; i < d[0].length; i++) if (typeof d[0][i] === 'string') out.pinned[d[0][i]] = true;
    }
    pinsCache = out;
    return out;
  };
  var pinWait = {};
  var isPinned = function(id, d){
    var w = pinWait[id];
    if (w && Date.now() - w.at < PIN_WAIT_MS) return w.on;
    if (w) delete pinWait[id];
    return !!(d && d.pinned[id] === true);
  };
  /* The time a pinned conversation was really last active, while the list still shows the time its file was given. Once
     somebody writes to it, the list's time is later than that and is the true one again. */
  var realTime = function(id, last){
    try {
      var d = pinsNow();
      if (!d || typeof id !== 'string' || typeof last !== 'number' || !Object.prototype.hasOwnProperty.call(d.times, id)) return null;
      var r = d.times[id];
      if (!r || typeof r[0] !== 'number' || typeof r[1] !== 'number') return null;
      return Math.abs(last - r[1]) <= PIN_SAME_MS ? r[0] : null;
    } catch (e) { return null; }
  };
  var pinDays = function(m){
    if (!(m >= 1)) return 'a day';
    var n = Math.floor(m);
    return 'about ' + n + (n === 1 ? ' day' : ' days');
  };
  var pinLabel = function(on, d){
    var after = 'Unpinned, it is archived and cleaned up as usual again, so one kept past its age can be deleted within '
      + pinDays(d && d.margin) + ' unless you use it.';
    return (on
      ? 'Pinned: Claude Code\'s transcript cleanup will not delete this conversation, and it will not be moved to '
        + 'Archived sessions. Click to unpin. '
      : 'Pin this conversation so Claude Code\'s transcript cleanup does not delete it and it is not moved to '
        + 'Archived sessions. Click again to unpin. ') + after;
  };
  var paintPin = function(el, on, d){
    var set = function(k, v){ if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
    if (!d) { set('data-cce-pin-off', '1'); return; }
    if (el.hasAttribute('data-cce-pin-off')) el.removeAttribute('data-cce-pin-off');
    set('data-cce-pinned', on ? '1' : '0');
    set('aria-pressed', on ? 'true' : 'false');
    set('aria-label', pinLabel(on, d));
  };
  /* The rows the list does not draw again are brought up to date here: when a stylesheet arrives, and when a click the
     host did not answer stops being shown. */
  var repaintPins = function(){
    var d = pinsNow(), els = document.querySelectorAll('span[data-cce-pin]');
    for (var i = 0; i < els.length; i++) paintPin(els[i], isPinned(els[i].getAttribute('data-cce-pin'), d), d);
  };
  var sendPin = function(id, on){
    /* The handle the panel's own bundle asked for, which src/panel-tz.js hands out again rather than asking twice. */
    try { acquireVsCodeApi().postMessage({ type: 'cce_session_pin', sessionId: id, pinned: on }); return true; }
    catch (e) { return false; }
  };
  var togglePin = function(id, el){
    var d = pinsNow();
    if (!d) return;
    var on = !isPinned(id, d);
    if (!sendPin(id, on)) return;
    pinWait[id] = { on: on, at: Date.now() };
    hideLabel();
    if (el) paintPin(el, on, d);
    setTimeout(function(){ try { repaintPins(); } catch (e) { /* the next render of the list does it */ } }, PIN_WAIT_MS + 100);
  };
  window.__ccePin = function(h, row){
    try {
      if (!row || row.transcriptOnDisk !== true) return null;
      var id = row.sessionId && row.sessionId.value;
      if (typeof id !== 'string' || !PIN_SESSION.test(id)) return null;
      if (!pinStyle) {
        pinStyle = document.createElement('style');
        pinStyle.setAttribute('data-cce-pins', '1');
        pinStyle.textContent = PIN_CSS;
        head.appendChild(pinStyle);
      }
      var d = pinsNow(), on = isPinned(id, d);
      var act = function(e){ e.stopPropagation(); togglePin(id, e.currentTarget); };
      return h('span', {
        role: 'button', tabIndex: 0,
        'data-cce-pin': id, 'data-cce-pin-off': d ? void 0 : '1',
        'data-cce-pinned': on ? '1' : '0', 'aria-pressed': on ? 'true' : 'false', 'aria-label': pinLabel(on, d),
        onClick: act,
        onKeyDown: function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); } },
        onMouseEnter: function(e){ showLabel(e.currentTarget); },
        onMouseLeave: function(){ hideLabel(); },
        children: [h('svg', {
          width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          children: [h('path', { 'data-cce-pin-body': '1', d: PIN_BODY }, 'b'), h('path', { d: PIN_LINES }, 'l')],
        }, 's')],
      }, 'cce-pin');
    } catch (e) { return null; }
  };

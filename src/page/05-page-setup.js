// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Selectors, the live stylesheet, and its revision probe.
// Fragment of the in-page script - see README.md in this folder.

  // When this script started, for the one-line startup timing printed after the first sweep.
  var T0 = (function(){ try { return performance.now(); } catch (e) { return 0; } })();

  /*
   * The two searches whose cost no element count can express: walking up React's own tree to find the message a row
   * belongs to, and walking down a row's tree to find the element holding its first line of text. Both are bounded
   * per call and cached afterwards, so they vanish from a total - yet on a first sweep across a long conversation
   * they are where the time goes. Each adds the steps it took, once per call, so a report can name them.
   */
  var WALK = { fiber: 0, text: 0 };

  var USER = '[class*="userMessage_"]', ASSIST = '[data-testid="assistant-message"]';
  var COMPACT = 'details[class*="compact"]';
  // The send button is the footer toolbar's stable anchor: the permission-mode selector is its previous sibling, every
  // control this extension adds is placed against it, and it is the one element of the panel that is present before
  // the conversation has anything in it.
  var SEND = 'button[type="submit"][data-permission-mode]';
  var head = document.head || document.documentElement;

  /* The bar on your own messages, put in once and never touched again. It is here rather than in the live stylesheet
     because that file is shared by every window: a window running an older build rewrites it without knowing the rule
     exists, which made the bar blink. Its switch is a custom property the stylesheet may set, and an absent property
     counts as on - so a stylesheet that knows nothing about it leaves the bar alone. */
  (function(){
    var edge = document.createElement('style');
    edge.setAttribute('data-cce-edge', '1');
    edge.textContent = EDGE_CSS;
    head.appendChild(edge);
  })();

  /*
   * Hover text for the controls this script adds, drawn rather than left to the browser.
   *
   * The native `title` attribute does not surface in this panel. Its own footer hints are a component it renders on
   * mouseenter - the context meter's is one of them - and not one control in that row carries a `title` that a reader
   * ever sees. So relying on the attribute meant these buttons had no hover text at all, however carefully it was set.
   *
   * The box is styled from the same theme variables the panel's own hint uses, rather than by borrowing its class: the
   * build hashes the suffix of every class name, and matching `popup_` by pattern would just as happily find some other
   * component's popup. `aria-label` carries the text, which is what the panel's own buttons use for it, and is what the
   * handler below reads - so changing the label needs no rewiring.
   */
  var labelBox = null;
  var hideLabel = function(){
    if (labelBox && labelBox.parentNode) labelBox.parentNode.removeChild(labelBox);
    labelBox = null;
  };
  var showLabel = function(el){
    var text = el && el.getAttribute('aria-label');
    if (!text) return;
    hideLabel();
    var box = document.createElement('div');
    box.setAttribute('data-cce-label', '1');
    var s = box.style;
    s.position = 'fixed'; s.zIndex = '1000'; s.pointerEvents = 'none';
    s.maxWidth = '260px'; s.padding = '8px';
    s.background = 'var(--app-menu-background, var(--vscode-editorWidget-background, #252526))';
    s.border = '1px solid var(--app-input-border, var(--vscode-widget-border, #454545))';
    s.borderRadius = 'var(--corner-radius-large, 6px)';
    s.color = 'var(--app-primary-foreground, var(--vscode-foreground, #ccc))';
    s.fontSize = '.9em'; s.lineHeight = '1.35';
    box.textContent = text;
    document.body.appendChild(box);
    /* Measured after it is in the document, because its height depends on how many lines the text wrapped to. Above the
       button when there is room, and kept inside the panel on both sides - the footer's rightmost controls would
       otherwise put the box off the edge. */
    var r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    s.left = Math.max(8, Math.min(window.innerWidth - b.width - 8, r.left + r.width / 2 - b.width / 2)) + 'px';
    s.top = (r.top - b.height - 8 >= 8 ? r.top - b.height - 8 : r.bottom + 8) + 'px';
    labelBox = box;
  };
  var setLabel = function(el, text){
    if (!el) return;
    if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
    if (el.hasAttribute('data-cce-labelled')) return;
    el.setAttribute('data-cce-labelled', '1');
    el.addEventListener('mouseenter', function(){ showLabel(el); });
    el.addEventListener('mouseleave', hideLabel);
    // A box left hanging over a control the reader has just acted on reads as stuck rather than as informative.
    el.addEventListener('click', hideLabel);
  };
  /* Same reason, for the properties those repaints write: an unchanged value is not worth a mutation. */
  var setStyle = function(el, prop, value){
    if (el && el.style[prop] !== value) el.style[prop] = value;
  };

  // ── live settings: stylesheet + revision probe from the panel's own folder ──
  var fallback = null, sheet = null, loadedOnce = false, lastRev = -1;
  var base = (function(){
    var l = document.querySelector('link[rel="stylesheet"][href*="index.css"]');
    return l ? String(l.href).replace(/index\.css([?#].*)?$/, '') : null;
  })();
  var useFallback = function(){
    if (fallback || loadedOnce) return;
    fallback = document.createElement('style');
    fallback.textContent = STAMP_CSS;
    head.appendChild(fallback);
  };
  /*
   * Load the settings stylesheet WITHOUT blocking the first paint.
   *
   * A plain <link rel="stylesheet"> stops the browser painting until the file has arrived, and on a remote host that
   * file is a round trip away - so an ordinary insert here held the panel blank for as long as the round trip took,
   * on every open, whether or not the conversation had anything in it. `media="print"` makes it a non-blocking load;
   * the media attribute is switched to all once it is in, which applies it in one go.
   *
   * The address carries the revision rather than the clock: a new address on every load meant the browser could never
   * reuse what it already had, so every panel re-fetched a file that had not changed. With the revision in it, the
   * address only changes when the content does - which is exactly when a re-fetch is wanted.
   */
  var cssUrl = function(){ return base + LIVE_CSS + (lastRev >= 0 ? '?v=' + lastRev : ''); };
  var reloadCss = function(){
    if (!base) { useFallback(); return; }
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.media = 'print';
    l.href = cssUrl();
    l.onload = function(){
      l.media = 'all';
      if (sheet && sheet !== l && sheet.parentNode) sheet.parentNode.removeChild(sheet);
      sheet = l; loadedOnce = true; onCache = null; offCache = {};
      if (fallback && fallback.parentNode) { fallback.parentNode.removeChild(fallback); fallback = null; }
      schedule();
    };
    l.onerror = function(){ if (l.parentNode) l.parentNode.removeChild(l); useFallback(); onCache = null; offCache = {}; schedule(); };
    head.appendChild(l);
  };
  var probe = function(){
    if (!base) return;
    var img = new Image();
    img.onload = function(){ var w = img.naturalWidth; if (w !== lastRev) { var first = lastRev === -1; lastRev = w; if (!first) reloadCss(); } };
    img.src = base + LIVE_REV + '?t=' + Date.now();
  };
  /*
   * Held between stylesheet loads. getComputedStyle is a synchronous read that forces style resolution, and while a
   * stylesheet is still in flight the browser blocks on it - so asking four times a second turned a setting nobody
   * changes into repeated stalls during startup. The answer can only change when the stylesheet is replaced, and both
   * paths that replace it clear this.
   */
  var onCache = null;
  var isOn = function(){
    if (onCache !== null) return onCache;
    try {
      var v = String(getComputedStyle(document.documentElement).getPropertyValue('--cce-on') || '').trim();
      onCache = v !== '0';
    } catch (e) { onCache = true; }
    return onCache;
  };
  /*
   * Whether one addition has been switched off, from the same stylesheet and with the same caching.
   *
   * A property is written only for the ones turned off, so absent means on: a stylesheet then carries no trace of a
   * setting left at its default, and a build that has never heard of a switch behaves as though it were on rather than
   * off. Every caller is expected to skip the work as well as the drawing - hiding the result with CSS while still
   * computing it every refresh is the one outcome a switch must not have.
   */
  var offCache = {};
  var isOff = function(key){
    if (Object.prototype.hasOwnProperty.call(offCache, key)) return offCache[key];
    var v = false;
    try {
      v = String(getComputedStyle(document.documentElement)
        .getPropertyValue('--cce-off-' + key) || '').trim() === '1';
    } catch (e) { v = false; }
    offCache[key] = v;
    return v;
  };

  // ── marks ──

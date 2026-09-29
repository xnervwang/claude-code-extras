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

  /*
   * Give a control its hover text, and write it only where it changed.
   *
   * The guard is the point of this rather than an economy. Every control this script adds to the footer is repainted on
   * a 700 ms timer so that it survives the panel replacing the row it sits in - and the browser decides when a tooltip
   * may appear by watching that same attribute, so rewriting the string twice a second kept the wait from ever
   * finishing and those buttons had no hover text at all. A button whose whole face is one character has no other way
   * to say what it does, which is also why the text is set as the accessible name.
   */
  var setLabel = function(el, text){
    if (!el || el.title === text) return;
    el.title = text;
    el.setAttribute('aria-label', text);
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
      sheet = l; loadedOnce = true; onCache = null;
      if (fallback && fallback.parentNode) { fallback.parentNode.removeChild(fallback); fallback = null; }
      schedule();
    };
    l.onerror = function(){ if (l.parentNode) l.parentNode.removeChild(l); useFallback(); onCache = null; schedule(); };
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

  // ── marks ──

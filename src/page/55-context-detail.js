// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The context breakdown shown on hovering the usage meter.
// Fragment of the in-page script - see README.md in this folder.

  // Context usage detail on hover. The request crosses into the CLI and recomputes per-part token
  // counts, so it is never polled: it fires 400ms after the pointer settles on the meter, and the
  // result is cached until the used-token count changes (once per turn at most).
  var CTX = null, ctxCache = null, ctxKey = '', ctxAt = 0, ctxOpenTimer = null, ctxHideTimer = null, ctxBusy = false;
  var ctxBtn = null, ctxOver = false;
  var CTX_TTL = 20000;  // even with an unchanged token count, the breakdown can shift when CLAUDE.md, skills or memory files change between turns
  var ctxWired = (typeof WeakSet === 'function') ? new WeakSet() : null;

  var kfmt = function(n){
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  };
  // Laid out like the /context view, and coloured from the same eight chart variables the panel uses there, so the
  // two read as one thing. The class names in that view carry a per-build hash, so the look is rebuilt here from
  // plain styles rather than borrowed by name.
  var CHART_FALLBACK = ['#7aa2f7', '#7dcfff', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#2ac3de', '#c0caf5'];
  var chartColor = function(i){
    var k = i % CHART_FALLBACK.length;
    return 'var(--app-chart-' + (k + 1) + ', ' + CHART_FALLBACK[k] + ')';
  };
  var pctText = function(tokens, max){
    if (!(max > 0)) return '';
    var v = tokens / max * 100;
    return v < 0.1 ? '<0.1%' : v.toFixed(1) + '%';
  };
  // Home directories are shown as ~ the way the panel does it, so a long path leaves room for the figure. Written
  // with plain string work on purpose: this whole script is a template literal, and a regex containing a slash needs
  // an escape level that is easy to get wrong and fails only at runtime.
  var HOME_PREFIX = ['/Users/', '/home/'];
  var shortPath = function(path){
    var p = String(path || '');
    for (var i = 0; i < HOME_PREFIX.length; i++) {
      if (p.indexOf(HOME_PREFIX[i]) !== 0) continue;
      var rest = p.slice(HOME_PREFIX[i].length), cut = rest.indexOf('/');
      return cut === -1 ? '~' : '~' + rest.slice(cut);
    }
    if (p.indexOf('/root') === 0) return '~' + p.slice(5);
    return p;
  };
  var swatch = function(color){
    var s = document.createElement('span');
    s.style.flex = '0 0 auto'; s.style.width = '8px'; s.style.height = '8px';
    s.style.borderRadius = '2px'; s.style.marginRight = '6px';
    if (color) s.style.background = color;
    return s;
  };
  var ctxRow = function(name, tokens, pct, color, dim){
    var row = document.createElement('div');
    row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.padding = '1px 0';
    if (dim) row.style.opacity = '0.65';
    row.appendChild(swatch(color));
    var a = document.createElement('span');
    a.textContent = name;
    a.title = name;
    a.style.flex = '1 1 auto'; a.style.minWidth = '0';
    a.style.overflow = 'hidden'; a.style.textOverflow = 'ellipsis'; a.style.whiteSpace = 'nowrap';
    var b = document.createElement('span');
    b.textContent = kfmt(tokens);
    b.style.flex = '0 0 auto'; b.style.width = '54px'; b.style.textAlign = 'right';
    b.style.fontVariantNumeric = 'tabular-nums';
    var c = document.createElement('span');
    c.textContent = pct || '';
    c.style.flex = '0 0 auto'; c.style.width = '48px'; c.style.textAlign = 'right';
    c.style.opacity = '0.75'; c.style.fontVariantNumeric = 'tabular-nums';
    row.appendChild(a); row.appendChild(b); row.appendChild(c);
    return row;
  };
  var ctxHead = function(title, hint){
    var d = document.createElement('div');
    d.style.display = 'flex'; d.style.alignItems = 'baseline'; d.style.gap = '6px';
    d.style.marginTop = '8px'; d.style.paddingTop = '5px';
    d.style.borderTop = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.12))';
    var t = document.createElement('span');
    t.textContent = title;
    t.style.fontWeight = '600';
    d.appendChild(t);
    if (hint) {
      var h = document.createElement('span');
      h.textContent = hint;
      h.style.opacity = '0.55';
      d.appendChild(h);
    }
    return d;
  };
  var renderCtx = function(u){
    CTX.textContent = '';
    var cats = (u.categories || []).filter(function(c){ return c && c.tokens > 0 && !c.isDeferred; });
    var head = document.createElement('div');
    head.style.display = 'flex'; head.style.justifyContent = 'space-between';
    head.style.gap = '10px'; head.style.fontWeight = '600'; head.style.marginBottom = '6px';
    var model = document.createElement('span');
    model.textContent = u.model || '';
    model.style.overflow = 'hidden'; model.style.textOverflow = 'ellipsis'; model.style.whiteSpace = 'nowrap';
    var figures = document.createElement('span');
    figures.textContent = kfmt(u.totalTokens) + ' / ' + kfmt(u.rawMaxTokens) + ' tokens (' + u.percentage + '%)';
    figures.style.flex = '0 0 auto'; figures.style.fontVariantNumeric = 'tabular-nums';
    head.appendChild(model); head.appendChild(figures);
    CTX.appendChild(head);
    // One bar across the window, a segment per category. Free space is left out so the bar shows what is taken.
    var track = document.createElement('div');
    track.style.display = 'flex'; track.style.height = '6px'; track.style.borderRadius = '3px';
    track.style.overflow = 'hidden'; track.style.marginBottom = '8px';
    track.style.background = 'var(--vscode-widget-border, rgba(255,255,255,0.10))';
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].name === 'Free space') continue;
      var seg = document.createElement('div');
      seg.style.background = chartColor(i);
      seg.style.width = (u.rawMaxTokens > 0 ? cats[i].tokens / u.rawMaxTokens * 100 : 0) + '%';
      seg.title = cats[i].name + ': ' + kfmt(cats[i].tokens);
      track.appendChild(seg);
    }
    CTX.appendChild(track);
    var sorted = cats.slice().sort(function(a, b){ return b.tokens - a.tokens; });
    for (var j = 0; j < sorted.length; j++) {
      var free = sorted[j].name === 'Free space';
      CTX.appendChild(ctxRow(sorted[j].name, sorted[j].tokens, pctText(sorted[j].tokens, u.rawMaxTokens),
                             free ? null : chartColor(cats.indexOf(sorted[j])), free));
    }
    var mem = (u.memoryFiles || []).slice().sort(function(a, b){ return b.tokens - a.tokens; }).slice(0, 5);
    if (mem.length) {
      CTX.appendChild(ctxHead('Memory files', '/memory'));
      for (var k = 0; k < mem.length; k++) CTX.appendChild(ctxRow(shortPath(mem[k].path), mem[k].tokens, '', null));
    }
    var ags = (u.agents || []).slice().sort(function(a, b){ return b.tokens - a.tokens; }).slice(0, 5);
    if (ags.length) {
      CTX.appendChild(ctxHead('Custom agents', '/agents'));
      for (var q = 0; q < ags.length; q++) CTX.appendChild(ctxRow(ags[q].agentType, ags[q].tokens, '', null));
    }
  };
  var ensureCtx = function(){
    if (CTX && CTX.isConnected) return;
    CTX = document.createElement('div');
    CTX.id = 'cce-ctx';
    var s = CTX.style;
    s.position = 'fixed'; s.zIndex = '32'; s.display = 'none';
    s.width = '330px'; s.maxHeight = '60vh'; s.overflowY = 'auto';
    s.padding = '8px 10px'; s.borderRadius = '5px';
    s.fontSize = '11px'; s.lineHeight = '1.5';
    s.background = 'var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.99))';
    s.color = 'var(--vscode-editorHoverWidget-foreground, #ddd)';
    s.border = '1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.18))';
    s.boxShadow = '0 4px 14px rgba(0,0,0,0.5)';
    CTX.addEventListener('mouseenter', function(){
      ctxOver = true;
      if (ctxHideTimer) { clearTimeout(ctxHideTimer); ctxHideTimer = null; }
    });
    CTX.addEventListener('mouseleave', function(){ ctxOver = false; hideCtx(); });
    document.body.appendChild(CTX);
  };
  // The panel puts its own tooltip on this button, carrying the summary figure. Nothing of ours is written into it or
  // onto it - a node the panel owns is only ever read here, for its position. A node of ours placed inside one can
  // collide with the panel's own rendering, and when that throws, every click and key in the page stops working. So
  // ours stacks above it rather than replacing it.
  var nativeTip = function(){
    if (!ctxBtn || !ctxBtn.parentElement) return null;
    var kids = ctxBtn.parentElement.children;
    for (var i = 0; i < kids.length; i++) if (kids[i] !== ctxBtn) return kids[i];
    return null;
  };
  var anchorRect = function(){
    var ref = nativeTip() || ctxBtn;
    return ref ? ref.getBoundingClientRect() : null;
  };
  // A line of our own, sitting above the panel's tooltip, to say the breakdown is on its way.
  var NOTEBOX = null;
  var noteLine = function(text){
    if (!text) { if (NOTEBOX) NOTEBOX.style.display = 'none'; return; }
    if (!NOTEBOX || !NOTEBOX.isConnected) {
      NOTEBOX = document.createElement('div');
      NOTEBOX.id = 'cce-ctx-note';
      var s = NOTEBOX.style;
      s.position = 'fixed'; s.zIndex = '32'; s.display = 'none';
      s.padding = '4px 8px'; s.borderRadius = '4px';
      s.fontSize = '11px'; s.lineHeight = '1.4'; s.whiteSpace = 'nowrap';
      s.background = 'var(--vscode-editorHoverWidget-background, rgba(30,30,30,0.99))';
      s.color = 'var(--vscode-descriptionForeground, #aaa)';
      s.border = '1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.18))';
      s.pointerEvents = 'none';
      document.body.appendChild(NOTEBOX);
    }
    if (NOTEBOX.textContent !== text) NOTEBOX.textContent = text;
    var r = anchorRect(), b = ctxBtn && ctxBtn.getBoundingClientRect();
    if (r) NOTEBOX.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
    if (b) NOTEBOX.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
    NOTEBOX.style.display = 'block';
  };
  var placeCtx = function(btn){
    var r = anchorRect() || btn.getBoundingClientRect();
    var b = btn.getBoundingClientRect();
    CTX.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
    CTX.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
  };
  var hideCtx = function(){
    if (ctxHideTimer) clearTimeout(ctxHideTimer);
    ctxHideTimer = setTimeout(function(){
      ctxHideTimer = null;
      if (CTX) CTX.style.display = 'none';
      noteLine('');
    }, 200);
  };
  var ctxUsedKey = function(){
    var u = sessionRef && sessionRef.usageData && sessionRef.usageData.value;
    return u ? String(u.totalTokens) : '';
  };
  var ctxFresh = function(){
    return ctxCache !== null && ctxUsedKey() === ctxKey && (Date.now() - ctxAt) < CTX_TTL;
  };
  var showCtx = function(usage){
    if (!ctxOver || !ctxBtn) return;
    ensureCtx();
    placeCtx(ctxBtn);
    renderCtx(usage);
    CTX.style.display = 'block';
    noteLine('');
  };
  // The breakdown crosses into the command-line side and is recomputed there, so it is requested only after the
  // pointer settles. If it cannot be had, nothing of ours appears and the panel's own summary is left standing.
  var fetchCtx = function(){
    if (ctxBusy) return;
    var key = ctxUsedKey();
    if (ctxFresh()) return;
    if (!sessionRef || typeof sessionRef.getContextUsage !== 'function') return;
    ctxBusy = true;
    sessionRef.getContextUsage().then(function(res){
      ctxBusy = false;
      if (!res || !res.usage) { noteLine('Breakdown unavailable' + (res && res.error ? ': ' + res.error : '')); return; }
      ctxCache = res.usage; ctxKey = key; ctxAt = Date.now();
      showCtx(res.usage);
    }, function(){ ctxBusy = false; noteLine('Breakdown request failed'); });
  };
  var wireCtxButton = function(){
    var btn = document.querySelector('button[class*="usageButtonV2"]');
    if (!btn) return;
    if (ctxWired) { if (ctxWired.has(btn)) return; ctxWired.add(btn); }
    else if (btn.getAttribute('data-cce-ctx') === '1') return;
    else btn.setAttribute('data-cce-ctx', '1');
    ctxBtn = btn;
    btn.addEventListener('mouseenter', function(){
      ctxOver = true;
      if (ctxHideTimer) { clearTimeout(ctxHideTimer); ctxHideTimer = null; }
      if (ctxFresh()) showCtx(ctxCache);
      if (ctxOpenTimer) clearTimeout(ctxOpenTimer);
      // Two seconds resting on the button before anything happens: reading the panel's own summary, or passing over
      // on the way somewhere else, then costs nothing at all.
      ctxOpenTimer = setTimeout(function(){
        ctxOpenTimer = null;
        if (!ctxOver) return;
        noteLine('Loading breakdown...');
        fetchCtx();
      }, 2000);
    });
    btn.addEventListener('mouseleave', function(){
      ctxOver = false;
      if (ctxOpenTimer) { clearTimeout(ctxOpenTimer); ctxOpenTimer = null; }
      hideCtx();
    });
  };

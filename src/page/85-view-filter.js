// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Showing one side of the conversation at a time.
// Fragment of the in-page script - see README.md in this folder.

  // ── view filter: All / Main / one sub-agent ──
  // Ownership comes from the same value that produces the inline agent tag, so classification is
  // free here. Visibility is applied through inline styles (CSSOM is not subject to the page CSP)
  // and only written when it actually changes.
  // A sub-agent keeps its own transcript file and the panel does not replay those files when a session is
  // restored, so an agent can be known by name while none of its messages are on the page. Saying that out loud
  // beats leaving the reader with an empty panel.
  var NOTE_TEXT = 'No messages loaded for this agent. Sub-agents keep their own transcript files, which the panel does not replay when a session is restored.';
  var NOTE = null;
  var showNote = function(on){
    if (!on) { if (NOTE) NOTE.style.display = 'none'; return; }
    if (!NOTE || !NOTE.isConnected) {
      NOTE = document.createElement('div');
      NOTE.id = 'cce-note';
      var s = NOTE.style;
      s.position = 'fixed'; s.top = '40px'; s.left = '50%'; s.transform = 'translateX(-50%)';
      s.zIndex = '28'; s.maxWidth = '62%';
      s.padding = '5px 10px'; s.borderRadius = '4px';
      s.fontSize = '11px'; s.lineHeight = '1.5'; s.textAlign = 'center';
      s.background = 'var(--vscode-editorWidget-background, rgba(40,40,40,0.96))';
      s.color = 'var(--vscode-descriptionForeground, #aaa)';
      s.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.14))';
      s.pointerEvents = 'none';
      NOTE.textContent = NOTE_TEXT;
      document.body.appendChild(NOTE);
    }
    NOTE.style.display = 'block';
  };
  var OWNER_ATTR = 'data-cce-owner', SETTLED_ATTR = 'data-cce-settled', LIVE_TAIL = 60;
  var VIEW = 'all';
  var SEEN = [];            // agent ids actually rendered in this sweep, in first-seen order
  var VIEWBTN = null, VIEWMENU = null, viewWired = false;

  var ownerVisible = function(owner){
    if (VIEW === 'all') return true;
    if (VIEW === 'main') return owner === 'main';
    return owner === VIEW;
  };
  var applyOwner = function(el, owner){
    if (isOff('footerViewFilter')) return;
    if (el.getAttribute(OWNER_ATTR) !== owner) el.setAttribute(OWNER_ATTR, owner);
    var want = ownerVisible(owner) ? '' : 'none';
    if (el.style.display !== want) el.style.display = want;
  };
  var viewLabel = function(){
    if (VIEW === 'main') return 'Main';
    if (VIEW !== 'all') {
      var d = titles.get(VIEW);
      return d ? d.slice(0, 10) : VIEW.slice(-6);
    }
    var n = SEEN.length;
    for (var k = 0; k < KNOWN.length; k++) if (SEEN.indexOf(KNOWN[k]) === -1) n++;
    return n ? 'All ' + String.fromCharCode(183) + ' ' + n : 'All';
  };
  var closeViewMenu = function(){ if (VIEWMENU) VIEWMENU.style.display = 'none'; };
  var setView = function(v){
    VIEW = v;
    closeViewMenu();
    if (VIEWBTN) VIEWBTN.textContent = viewLabel();
    SIG = '';           // the table of contents must be rebuilt for the new view
    try { run(); } catch (e) {}
  };
  var menuRow = function(label, val, dotColor, dim){
    var d = document.createElement('div');
    d.style.display = 'flex'; d.style.alignItems = 'center'; d.style.gap = '6px';
    d.style.padding = '4px 10px'; d.style.cursor = 'pointer';
    if (dim) { d.style.opacity = '0.6'; d.title = NOTE_TEXT; }
    d.style.whiteSpace = 'nowrap'; d.style.overflow = 'hidden'; d.style.textOverflow = 'ellipsis';
    d.style.color = 'var(--vscode-foreground, #ddd)';
    if (val === VIEW) d.style.background = 'var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.12))';
    if (dotColor) {
      var dot = document.createElement('span');
      dot.style.flex = '0 0 auto'; dot.style.width = '6px'; dot.style.height = '6px';
      dot.style.borderRadius = '50%'; dot.style.background = dotColor;
      d.appendChild(dot);
    }
    var t = document.createElement('span');
    t.textContent = label;
    t.style.overflow = 'hidden'; t.style.textOverflow = 'ellipsis';
    d.appendChild(t);
    d.addEventListener('mouseenter', function(){ if (val !== VIEW) d.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'; });
    d.addEventListener('mouseleave', function(){ if (val !== VIEW) d.style.background = 'transparent'; });
    d.addEventListener('click', function(ev){ ev.stopPropagation(); setView(val); });
    VIEWMENU.appendChild(d);
  };
  var buildViewMenu = function(){
    VIEWMENU.textContent = '';
    menuRow('All', 'all', null);
    menuRow('Main', 'main', null);
    var rest = [];
    for (var n = 0; n < KNOWN.length; n++) if (SEEN.indexOf(KNOWN[n]) === -1) rest.push(KNOWN[n]);
    if (SEEN.length || rest.length) {
      var hr = document.createElement('div');
      hr.style.height = '1px'; hr.style.margin = '4px 0';
      hr.style.background = 'var(--vscode-widget-border, rgba(255,255,255,0.16))';
      VIEWMENU.appendChild(hr);
      var tasks = sessionRef && sessionRef.agentMapAgents && sessionRef.agentMapAgents.value;
      for (var i = 0; i < SEEN.length; i++) {
        var id = SEEN[i], label = titles.get(id) || id.slice(-6), st = null;
        if (tasks && typeof tasks.values === 'function') {
          for (var it = tasks.values(), s = it.next(); !s.done; s = it.next()) {
            var tk = s.value;
            if (!tk) continue;
            var ids = [tk.toolUseId].concat(tk.wakeToolUseIds || []);
            if (ids.indexOf(id) !== -1) { st = tk.status; break; }
          }
        }
        var color = st === 'working' ? 'var(--vscode-charts-blue, #4aa)' :
                    st === 'failed' || st === 'stopped' ? 'var(--vscode-charts-red, #d55)' :
                    'var(--vscode-descriptionForeground, #888)';
        menuRow(label, id, color);
      }
      for (var r = 0; r < rest.length; r++) {
        menuRow(titles.get(rest[r]) || rest[r].slice(-6), rest[r], 'var(--vscode-descriptionForeground, #666)', true);
      }
    }
  };
  var ensureViewControl = function(){
    if (!SEEN.length && !KNOWN.length && !VIEWBTN) return;   // nothing to switch between yet
    if (VIEWBTN && VIEWBTN.isConnected) { VIEWBTN.textContent = viewLabel(); return; }
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    VIEWBTN = document.createElement('button');
    VIEWBTN.type = 'button';
    VIEWBTN.setAttribute('data-cce-view', '1');
    var proto = document.querySelector('button[class*="modelPill"]') || document.querySelector('button[class*="menuButton"]');
    if (proto) VIEWBTN.className = proto.className;
    VIEWBTN.style.maxWidth = '120px';
    VIEWBTN.style.overflow = 'hidden';
    VIEWBTN.style.textOverflow = 'ellipsis';
    VIEWBTN.style.whiteSpace = 'nowrap';
    VIEWBTN.textContent = viewLabel();
    setLabel(VIEWBTN, 'Whose messages to show: the main conversation, or one of the subagents it ran');
    VIEWBTN.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      if (!VIEWMENU) return;
      if (VIEWMENU.style.display === 'block') { closeViewMenu(); return; }
      buildViewMenu();
      var r = VIEWBTN.getBoundingClientRect();
      VIEWMENU.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
      // clamped: the control sits on the right of the toolbar, so an unclamped left edge puts the menu off screen
      VIEWMENU.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 308)) + 'px';
      VIEWMENU.style.display = 'block';
    });
    // Left of the chime toggle, which itself sits left of the mode selector. When the toggle has not been created
    // yet the mode selector is the anchor instead, and the toggle then lands to our right on its own.
    var before = (MUTE && MUTE.isConnected && MUTE.parentElement === mode.parentElement) ? MUTE : mode;
    mode.parentElement.insertBefore(VIEWBTN, before);

    VIEWMENU = document.createElement('div');
    VIEWMENU.id = 'cce-view-menu';
    var m = VIEWMENU.style;
    m.position = 'fixed'; m.zIndex = '33'; m.display = 'none';
    m.minWidth = '160px'; m.maxWidth = '300px'; m.maxHeight = '50vh'; m.overflowY = 'auto';
    m.padding = '4px 0'; m.borderRadius = '5px'; m.fontSize = '11px'; m.lineHeight = '1.4';
    m.background = 'var(--vscode-editorWidget-background, rgba(35,35,35,0.98))';
    m.border = '1px solid var(--vscode-widget-border, rgba(255,255,255,0.16))';
    m.boxShadow = '0 4px 14px rgba(0,0,0,0.45)';
    document.body.appendChild(VIEWMENU);
    if (!viewWired) {
      viewWired = true;
      document.addEventListener('click', function(ev){
        if (!VIEWMENU || VIEWMENU.style.display !== 'block') return;
        if (VIEWMENU.contains(ev.target) || (VIEWBTN && VIEWBTN.contains(ev.target))) return;
        closeViewMenu();
      });
    }
  };

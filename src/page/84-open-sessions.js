// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// OPEN SESSIONS at the top of the session list: the conversations this window has open, in an editor tab or in the
// sidebar, most recently active first.
// Fragment of the in-page script - see README.md in this folder.

  // The section is part of the session list's own render: edits in src/webview.js hand over the list's element
  // factories, its section classes and chevron, the component it draws a row with, the status dot, and the objects it
  // reads its sessions from. A throw here would take the list down with it, so the entry point returns null on any
  // failure.
  //
  // A row here is the list's own row component, so it carries everything a row below carries - the pin, the time and
  // date span, rename and archive - and can be the one place a person works from. Clicking one switches to that
  // conversation and leaves the list below where it was: the list would otherwise scroll to the conversation and select
  // it, which moves the long list under someone who is not looking at it.
  var OPEN_COLLAPSED_KEY = 'cce.openSessionsCollapsed';
  var OPEN_CSS = '[data-cce-open-sessions][data-cce-collapsed="1"] [data-cce-open-body]{display:none}'
    + '[data-cce-open-count]{margin-left:auto;padding:0 6px;border-radius:9px;font-size:.85em;line-height:16px;'
    + 'background:var(--vscode-badge-background,rgba(128,128,128,.35));color:var(--vscode-badge-foreground,inherit)}';
  var openStyle = null;
  var openCollapsed = function(){
    try { return localStorage.getItem(OPEN_COLLAPSED_KEY) === '1'; } catch (e) { return false; }
  };
  // The list's own short form, so a row here reads the same as the same conversation's row below.
  var openAge = function(ms){
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var s = Math.floor((Date.now() - ms) / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    var mo = Math.floor(d / 30), y = Math.floor(d / 365);
    return y > 0 ? y + 'y' : mo > 0 ? mo + 'mo' : d > 0 ? d + 'd' : h > 0 ? h + 'h' : m > 0 ? m + 'm' : 'now';
  };
  var asList = function(v){ return Array.isArray(v) ? v : v && typeof v.forEach === 'function' ? Array.from(v) : []; };
  // The state the list's own rows give an open conversation: waiting outranks running, and an idle one that finished
  // unseen is unread.
  var openState = function(reported, unread){
    if (reported === 'waiting') return 'waiting';
    if (reported === 'running') return 'running';
    return unread ? 'unread' : 'idle';
  };
  var OPEN_WHERE = { tab: 'Open in a tab', sidebar: 'Open in the sidebar' };
  var openDotTitle = function(state, where){
    if (state === 'unread') return 'Unread';
    var at = OPEN_WHERE[where];
    return state === 'waiting' ? at + ' — awaiting input' : state === 'running' ? at + ' — running' : at;
  };

  /*
   * This window's open conversations, most recently active first. The tab ones are the list's own openSessionIds and the
   * sidebar one its sidebarSessionIds, while the sidebar is shown; a conversation in both is listed once, as a tab. One
   * with no row in the list yet - just started, nothing on disk - counts as active now, which is what it is.
   */
  var openSessionsNow = function(src){
    var comms = src.comms, items = asList(src.sessions && src.sessions.sessions && src.sessions.sessions.value);
    var byId = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i], sid = it && it.sessionId && it.sessionId.value;
      if (typeof sid === 'string' && !(it.isRemote && it.isRemote.value)) byId[sid] = it;
    }
    var states = {}, st = asList(comms.sessionStates && comms.sessionStates.value);
    for (var j = 0; j < st.length; j++) if (st[j] && typeof st[j].sessionId === 'string') states[st[j].sessionId] = st[j];
    var unread = {}, un = asList(comms.unreadSessionKeys && comms.unreadSessionKeys.value);
    for (var k = 0; k < un.length; k++) unread[un[k]] = true;
    var seen = {}, out = [], now = Date.now();
    var add = function(ids, where){
      for (var n = 0; n < ids.length; n++) {
        var id = ids[n];
        if (typeof id !== 'string' || seen[id]) continue;
        var item = byId[id], info = states[id];
        if (!item && !info) continue;
        seen[id] = true;
        var last = item && item.lastModifiedTime ? item.lastModifiedTime.value : void 0;
        out.push({
          id: id, where: where, item: item || null,
          title: (item && item.summary && item.summary.value) || (info && info.title) || 'New session',
          last: typeof last === 'number' && isFinite(last) ? last : now,
          state: openState(info && info.state, !!unread[id]),
        });
      }
    };
    add(asList(comms.openSessionIds && comms.openSessionIds.value), 'tab');
    // A hidden sidebar keeps its conversation loaded; only a host from before the patch leaves this unsaid.
    if (window.__cceSidebarShown !== false) add(asList(comms.sidebarSessionIds && comms.sidebarSessionIds.value), 'sidebar');
    out.sort(function(a, b){ return b.last - a.last; });
    return out;
  };

  var toggleOpenSessions = function(e){
    try {
      var root = e.currentTarget.closest('[data-cce-open-sessions]');
      if (!root) return;
      var collapsed = root.getAttribute('data-cce-collapsed') !== '1';
      try { localStorage.setItem(OPEN_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (err) { /* kept for this page only */ }
      // Attributes only, on elements of our own: the next render of the list computes the same from the stored value.
      root.setAttribute('data-cce-collapsed', collapsed ? '1' : '0');
      e.currentTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      var chev = e.currentTarget.querySelector('[data-cce-open-chevron]'), on = chev && chev.getAttribute('data-cce-open-chevron');
      if (chev && on && chev.firstElementChild) chev.firstElementChild.classList.toggle(on, !collapsed);
    } catch (err) { /* the section stays as it was */ }
  };

  /* Which row is being renamed, as a signal of the panel's own kind: read during the list's render, it re-renders the
     list when set, which is how the list's own rename works. Made on first use, since the edit hands over the signal
     constructor only once the panel has loaded. */
  var openRenaming = null;
  var renamingNow = function(){
    if (!openRenaming && typeof window.__cceSignal === 'function') openRenaming = window.__cceSignal(null);
    return openRenaming ? openRenaming.value : null;
  };
  var setRenaming = function(id){ if (openRenaming) openRenaming.value = id; };
  /* The conversation last switched to from here. The list scrolls to the active conversation and selects it whenever
     the active one changes; for this one it is told not to, until some other way makes another one active. */
  var openFollowSkip = null;
  window.__cceSkipFollow = function(active){
    try {
      var id = active && active.sessionId && active.sessionId.value;
      if (openFollowSkip && id === openFollowSkip) return true;
      openFollowSkip = null;
    } catch (e) { /* the list does what it always does */ }
    return false;
  };

  window.__cceOpenSessions = function(ui){
    try {
      var renaming = renamingNow();
      if (isOff('openSessions')) return null;
      var src = window.__cceSessionList;
      if (!ui || typeof ui.jsx !== 'function' || typeof ui.jsxs !== 'function' || !src || !src.comms || !src.context) return null;
      var rows = openSessionsNow(src);
      if (!rows.length) return null;
      if (!openStyle) {
        openStyle = document.createElement('style');
        openStyle.setAttribute('data-cce-open-sessions-style', '1');
        openStyle.textContent = OPEN_CSS;
        head.appendChild(openStyle);
      }
      var F = ui.jsx, W = ui.jsxs, c = ui.cls || {}, l = window.__cceListCls || {}, Dot = window.__cceStatusDot;
      var Row = window.__cceSessionRow, store = src.sessions;
      var active = src.comms.activeSessionId && src.comms.activeSessionId.value;
      var collapsed = openCollapsed();
      var open = function(row){
        openFollowSkip = row.id;
        try { src.context.openInEditor(row.id, void 0, { openState: row.state, isRemote: false }); } catch (e) { /* nothing opens */ }
      };
      var noop = function(){};
      var body = rows.map(function(row){
        if (Row && row.item) {
          var archived = !!(row.item.archived && row.item.archived.value);
          return F(Row, {
            id: 'cce-open-' + row.id, session: row.item,
            isActive: row.id === active, isHighlighted: false, isSelected: false, isRenaming: renaming === row.id, searchQuery: '',
            onClick: function(){ open(row); },
            onFocus: noop, onMouseMove: noop, draggable: false,
            onKeyDown: function(e){ if (e && e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); open(row); } },
            onStartRename: openRenaming ? function(){ setRenaming(row.id); } : void 0,
            onFinishRename: function(item, text){
              setRenaming(null);
              var t = String(text || '').replace(/^\s+|\s+$/g, '');
              if (t && t !== row.title && store && typeof store.renameSession === 'function') store.renameSession(row.id, t);
            },
            onCancelRename: function(){ setRenaming(null); },
            // As the list decides it: archive for a conversation that is not archived, unarchive for one that is.
            onArchive: !archived && store && typeof store.archiveSession === 'function' ? function(item){ store.archiveSession(item); } : void 0,
            onUnarchive: archived && store && typeof store.unarchiveSession === 'function' ? function(item){ store.unarchiveSession(item); } : void 0,
            currentCwd: src.context.defaultCwd && src.context.defaultCwd.value,
            openState: row.state,
          }, row.id);
        }
        return W('button', {
          type: 'button', className: (l.sessionItem || '') + (row.id === active && l.active ? ' ' + l.active : ''),
          'data-cce-open-row': row.id, title: row.title,
          onClick: function(){ open(row); },
          children: [
            typeof Dot === 'function' ? F(Dot, { state: row.state, title: openDotTitle(row.state, row.where) }) : null,
            F('span', { className: l.sessionName || '', children: row.title }),
            F('span', { className: l.sessionMeta || '', children:
              F('span', { className: l.sessionTime || '', children: openAge(row.last) + (row.where === 'sidebar' ? ' · sidebar' : '') }),
            }),
          ],
        }, row.id);
      });
      return W('div', {
        'data-cce-open-sessions': '1', 'data-cce-collapsed': collapsed ? '1' : '0',
        children: [
          F('div', { className: c.sectionHeader || '', children: W('button', {
            className: c.sectionToggle || '', onClick: toggleOpenSessions, 'aria-expanded': collapsed ? 'false' : 'true',
            title: collapsed ? 'Expand open sessions' : 'Collapse open sessions',
            children: [
              ui.Chevron ? F('span', { 'data-cce-open-chevron': c.sectionChevronExpanded || '', style: { display: 'inline-flex' },
                children: F(ui.Chevron, { className: (c.sectionChevron || '') + (collapsed ? '' : ' ' + (c.sectionChevronExpanded || '')) }),
              }) : null,
              F('span', { className: c.sectionLabel || '', children: 'Open sessions' }),
              F('span', { 'data-cce-open-count': '1', children: String(rows.length) }),
            ],
          }) }),
          F('div', { 'data-cce-open-body': '1', className: l.sessionsList || '', children: body }),
        ],
      });
    } catch (e) { return null; }
  };

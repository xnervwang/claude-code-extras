// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// OPEN SESSIONS at the top of the session list: the conversations this window has open, in an editor tab or in the
// sidebar, most recently active first.
// Fragment of the in-page script - see README.md in this folder.

  // The section is part of the session list's own render: edits in src/webview.js hand over the list's element
  // factories and class names, the status dot it draws, and the objects it reads its sessions from. A throw here would
  // take the list down with it, so the entry point returns null on any failure.
  //
  // It is for moving between open conversations and nothing else. Pinning, renaming and archiving stay on the row in the
  // list below, which is where the same conversation also appears, and clicking a row here makes it the active one, so
  // the list follows it by itself.
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
   * sidebar one its sidebarSessionIds; a conversation in both is listed once, as a tab. One with no row in the list yet
   * - just started, nothing on disk - counts as active now, which is what it is.
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
          id: id, where: where,
          title: (item && item.summary && item.summary.value) || (info && info.title) || 'New session',
          last: typeof last === 'number' && isFinite(last) ? last : now,
          state: openState(info && info.state, !!unread[id]),
        });
      }
    };
    add(asList(comms.openSessionIds && comms.openSessionIds.value), 'tab');
    add(asList(comms.sidebarSessionIds && comms.sidebarSessionIds.value), 'sidebar');
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

  window.__cceOpenSessions = function(ui){
    try {
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
      var active = src.comms.activeSessionId && src.comms.activeSessionId.value;
      var collapsed = openCollapsed();
      var open = function(row){
        try { src.context.openInEditor(row.id, void 0, { openState: row.state, isRemote: false }); } catch (e) { /* nothing opens */ }
      };
      var body = rows.map(function(row){
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
          F('div', { 'data-cce-open-body': '1', children: body }),
        ],
      });
    } catch (e) { return null; }
  };

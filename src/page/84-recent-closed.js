// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Recently closed below OPEN SESSIONS: the Claude Code tabs last closed in this workspace, most recent first, leaving
// out any open again in a tab or the shown sidebar. Collapsed until opened.
// Fragment of the in-page script - see README.md in this folder.

  // The list comes from this extension by way of the patched host (src/recentclosed.js), with how many to show; the
  // rows are the session list's own, as in OPEN SESSIONS, and a click opens the conversation where Claude Code opens
  // one. Like OPEN SESSIONS it draws inside the list's render, so any failure returns null rather than throwing.
  var RECENT_EXPANDED_KEY = 'cce.recentClosedExpanded';
  var RECENT_CSS = '[data-cce-recent-closed][data-cce-collapsed="1"] [data-cce-recent-body]{display:none}'
    + '[data-cce-recent-count]{margin-left:auto;padding:0 6px;border-radius:9px;font-size:.85em;line-height:16px;'
    + 'background:var(--vscode-badge-background,rgba(128,128,128,.35));color:var(--vscode-badge-foreground,inherit)}';
  var recentStyle = null;
  var recentCollapsed = function(){
    try { return localStorage.getItem(RECENT_EXPANDED_KEY) !== '1'; } catch (e) { return true; }
  };
  var toggleRecentClosed = function(e){
    try {
      var root = e.currentTarget.closest('[data-cce-recent-closed]');
      if (!root) return;
      var collapsed = root.getAttribute('data-cce-collapsed') !== '1';
      try { localStorage.setItem(RECENT_EXPANDED_KEY, collapsed ? '0' : '1'); } catch (err) { /* kept for this page only */ }
      root.setAttribute('data-cce-collapsed', collapsed ? '1' : '0');
      e.currentTarget.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      var chev = e.currentTarget.querySelector('[data-cce-open-chevron]'), on = chev && chev.getAttribute('data-cce-open-chevron');
      if (chev && on && chev.firstElementChild) chev.firstElementChild.classList.toggle(on, !collapsed);
    } catch (err) { /* the section stays as it was */ }
  };

  /* The closed conversations to show: in the order closed, not open here now, known to the list, as many as asked. */
  var recentClosedNow = function(src, data){
    var max = data && Number(data.max);
    if (!(max >= 1) || !data || !Array.isArray(data.ids)) return [];
    var comms = src.comms, open = {};
    var tabs = asList(comms.openSessionIds && comms.openSessionIds.value);
    for (var i = 0; i < tabs.length; i++) open[tabs[i]] = true;
    if (window.__cceSidebarShown !== false) {
      var side = asList(comms.sidebarSessionIds && comms.sidebarSessionIds.value);
      for (var j = 0; j < side.length; j++) open[side[j]] = true;
    }
    var items = asList(src.sessions && src.sessions.sessions && src.sessions.sessions.value), byId = {};
    for (var k = 0; k < items.length; k++) {
      var it = items[k], sid = it && it.sessionId && it.sessionId.value;
      if (typeof sid === 'string' && !(it.isRemote && it.isRemote.value)) byId[sid] = it;
    }
    var out = [];
    for (var n = 0; n < data.ids.length && out.length < max; n++) {
      var id = data.ids[n];
      if (typeof id !== 'string' || open[id] || !byId[id]) continue;
      out.push({ id: id, item: byId[id], title: (byId[id].summary && byId[id].summary.value) || id, state: void 0 });
    }
    return out;
  };

  window.__cceRecentClosedSection = function(){
    try {
      var ui = lastListUi, src = window.__cceSessionList;
      if (!ui || typeof ui.jsx !== 'function' || typeof ui.jsxs !== 'function' || !src || !src.comms || !src.context) return null;
      renamingNow();
      var rows = recentClosedNow(src, window.__cceRecentClosed);
      if (!rows.length) return null;
      if (!recentStyle) {
        recentStyle = document.createElement('style');
        recentStyle.setAttribute('data-cce-recent-closed-style', '1');
        recentStyle.textContent = RECENT_CSS;
        head.appendChild(recentStyle);
      }
      var F = ui.jsx, W = ui.jsxs, c = ui.cls || {}, l = window.__cceListCls || {};
      var collapsed = recentCollapsed();
      var open = function(row){
        openFollowSkip = row.id;
        try { src.context.openInEditor(row.id, void 0, { openState: 'none', isRemote: false }); } catch (e) { /* nothing opens */ }
      };
      var body = [];
      for (var i = 0; i < rows.length; i++) {
        var drawn = listRowFor(ui, src, rows[i], 'cce-closed-', open);
        if (drawn) body.push(drawn);
      }
      if (!body.length) return null;
      return W('div', {
        'data-cce-recent-closed': '1', 'data-cce-collapsed': collapsed ? '1' : '0',
        children: [
          F('div', { className: c.sectionHeader || '', children: W('button', {
            className: c.sectionToggle || '', onClick: toggleRecentClosed, 'aria-expanded': collapsed ? 'false' : 'true',
            title: collapsed ? 'Expand recently closed sessions' : 'Collapse recently closed sessions',
            children: [
              ui.Chevron ? F('span', { 'data-cce-open-chevron': c.sectionChevronExpanded || '', style: { display: 'inline-flex' },
                children: F(ui.Chevron, { className: (c.sectionChevron || '') + (collapsed ? '' : ' ' + (c.sectionChevronExpanded || '')) }),
              }) : null,
              F('span', { className: c.sectionLabel || '', children: 'Recently closed' }),
              F('span', { 'data-cce-recent-count': '1', children: String(body.length) }),
            ],
          }) }),
          F('div', { 'data-cce-recent-body': '1', className: l.sessionsList || '', children: body }),
        ],
      });
    } catch (e) { return null; }
  };

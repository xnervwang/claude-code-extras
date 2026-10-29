// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// RECENTLY CLOSED above OPEN SESSIONS: the Claude Code tabs last closed in this workspace, most recent first, leaving
// out any open again in a tab or the shown sidebar. Collapsed until opened.
// Fragment of the in-page script - see README.md in this folder.

  // The list comes from this extension by way of the patched host (src/recentclosed.js), with how many to show; the
  // rows are the session list's own, as in OPEN SESSIONS, and a click opens the conversation where Claude Code opens
  // one. Like OPEN SESSIONS it draws inside the list's render, so any failure returns null rather than throwing.
  // The shell, the session lookup and what a click does are OPEN SESSIONS' own (84-open-sessions.js).
  var RECENT_SECTION = { attr: 'data-cce-recent-closed', key: 'cce.recentClosedExpanded', storesExpanded: true,
    label: 'RECENTLY CLOSED', title: 'recently closed sessions' };

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
    var find = sessionLookup(src), out = [];
    for (var n = 0; n < data.ids.length && out.length < max; n++) {
      var id = data.ids[n];
      if (typeof id !== 'string' || open[id]) continue;
      var it = find(id);
      if (!it) continue;
      out.push({ id: id, item: it, title: (it.summary && it.summary.value) || id, state: void 0 });
    }
    return out;
  };

  window.__cceRecentClosedSection = function(ui){
    try {
      var src = window.__cceSessionList;
      if (!ui || typeof ui.jsx !== 'function' || typeof ui.jsxs !== 'function' || !src || !src.comms || !src.context) return null;
      renamingNow();
      var rows = recentClosedNow(src, window.__cceRecentClosed);
      if (!rows.length) return null;
      var open = openFrom(src), body = [];
      for (var i = 0; i < rows.length; i++) {
        var drawn = listRowFor(ui, src, rows[i], 'cce-closed-', open);
        if (drawn) body.push(drawn);
      }
      if (!body.length) return null;
      return drawSection(ui, RECENT_SECTION, body.length, body);
    } catch (e) { return null; }
  };

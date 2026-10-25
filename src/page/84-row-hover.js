// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Hover text on the session list's rows, in OPEN SESSIONS and below it: the group the conversation is in, and its
// session ID.
// Fragment of the in-page script - see README.md in this folder.

  // The panel shows no native `title` tooltip (05-page-setup.js says why), so the text is drawn with the same box as the
  // other hover text of ours. The row component calls this as the pointer enters and leaves (an edit in src/webview.js).
  // The box waits a moment, as a tooltip does, so moving across the list does not flash one box per row.
  var ROW_HOVER_MS = 600;
  var rowHoverTimer = 0, rowHoverEl = null;
  var rowGroups = function(id){
    var names = [];
    try {
      var store = window.__cceSessionList && window.__cceSessionList.sessions;
      var groups = store && store.sessionGroups && store.sessionGroups.value;
      for (var g = 0; Array.isArray(groups) && g < groups.length; g++) {
        var grp = groups[g];
        if (grp && Array.isArray(grp.sessionIds) && grp.sessionIds.indexOf(id) >= 0 && grp.name) names.push(grp.name);
      }
    } catch (e) { /* no groups known */ }
    return names;
  };
  var rowHoverText = function(session){
    var id = session && session.sessionId && session.sessionId.value;
    if (typeof id !== 'string' || !id) return '';
    var names = rowGroups(id);
    return (names.length ? 'Group: ' + names.join(', ') : 'Not in a group') + '\nSession ID: ' + id;
  };
  var rowHoverEnd = function(){
    if (rowHoverTimer) { clearTimeout(rowHoverTimer); rowHoverTimer = 0; }
    if (rowHoverEl) { rowHoverEl = null; hideLabel(); }
  };
  window.__cceRowHover = function(session, el, entering){
    try {
      rowHoverEnd();
      if (!entering || !el || isOff('sessionHoverDetails')) return;
      var text = rowHoverText(session);
      if (!text) return;
      rowHoverTimer = setTimeout(function(){
        rowHoverTimer = 0;
        if (!el.isConnected) return;
        rowHoverEl = el;
        showLabel(el, text);
      }, ROW_HOVER_MS);
      // A box left over a row that was just clicked reads as stuck.
      el.addEventListener('mousedown', rowHoverEnd, { once: true });
    } catch (e) { /* no hover text */ }
  };

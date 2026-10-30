// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Hover text on the session list's rows, in OPEN SESSIONS and below it: the section the conversation is listed under -
// its group, Ungrouped or Archived sessions - and its session ID.
// Fragment of the in-page script - see README.md in this folder.

  // The panel shows no native `title` tooltip (05-page-setup.js says why), so the text is drawn with the same box as the
  // other hover text of ours. The row component calls this as the pointer enters and leaves (an edit in src/webview.js).
  // The box waits a moment, as a tooltip does, so moving across the list does not flash one box per row.
  var ROW_HOVER_MS = 600;
  // rowHoverAt is the row the pointer is on and its conversation, kept while the pointer is anywhere inside the row.
  var rowHoverTimer = 0, rowHoverEl = null, rowHoverAt = null;
  // The section the list puts the row under, decided as the list decides it: an archived conversation is under Archived
  // sessions whatever group it was in, one in a group under that group (the last group naming it, if several do), and
  // the rest under Ungrouped. A remote conversation's group key is not its plain ID, so for it only the ID is shown.
  var rowSection = function(session, id){
    if (session.archived && session.archived.value) return 'Archived sessions';
    var name = 'Ungrouped';
    try {
      var store = window.__cceSessionList && window.__cceSessionList.sessions;
      var groups = store && store.sessionGroups && store.sessionGroups.value;
      for (var g = 0; Array.isArray(groups) && g < groups.length; g++) {
        var grp = groups[g];
        if (grp && Array.isArray(grp.sessionIds) && grp.sessionIds.indexOf(id) >= 0) name = grp.name || 'Unnamed group';
      }
    } catch (e) { /* no groups known */ }
    return name;
  };
  var rowHoverText = function(session){
    var id = session && session.sessionId && session.sessionId.value;
    if (typeof id !== 'string' || !id) return '';
    var remote = !!(session.isRemote && session.isRemote.value);
    return (remote ? '' : 'Group: ' + rowSection(session, id) + '\n') + 'Session ID: ' + id;
  };
  var rowHoverEnd = function(){
    if (rowHoverTimer) { clearTimeout(rowHoverTimer); rowHoverTimer = 0; }
    if (rowHoverEl) { rowHoverEl = null; hideLabel(); }
  };
  var rowHoverStart = function(session, el){
    var text = rowHoverText(session);
    if (!text) return;
    rowHoverTimer = setTimeout(function(){
      rowHoverTimer = 0;
      if (!el.isConnected) return;
      rowHoverEl = el;
      showLabel(el, text);
    }, ROW_HOVER_MS);
  };
  window.__cceRowHover = function(session, el, entering){
    try {
      rowHoverEnd();
      rowHoverAt = entering && el ? { session: session, el: el } : null;
      if (!entering || !el || isOff('sessionHoverDetails')) return;
      rowHoverStart(session, el);
      // A box left over a row that was just clicked reads as stuck.
      el.addEventListener('mousedown', rowHoverEnd, { once: true });
    } catch (e) { /* no hover text */ }
  };
  /* The row pin (83-session-pins.js) uses the same tooltip box, so the row's tooltip is suppressed while the pointer is
     on the pin and reappears after the usual delay. */
  var rowHoverHold = function(){
    if (rowHoverTimer) { clearTimeout(rowHoverTimer); rowHoverTimer = 0; }
    rowHoverEl = null;
  };
  var rowHoverResume = function(){
    try {
      var at = rowHoverAt;
      if (!at || rowHoverTimer || !at.el.isConnected || isOff('sessionHoverDetails')) return;
      rowHoverStart(at.session, at.el);
    } catch (e) { /* no hover text */ }
  };

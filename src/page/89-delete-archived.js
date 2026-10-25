// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Delete in the Archived sessions menu: removes the selected conversations from disk once a confirmation in VS Code is
// accepted (src/deletesession.js says what goes). The page only asks; this extension shows the confirmation, checks
// that none is still running, and deletes.
// Fragment of the in-page script - see README.md in this folder.

  var DELETE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var deleteTitle = function(id){
    try {
      var items = window.__cceSessionList && window.__cceSessionList.sessions && window.__cceSessionList.sessions.sessions;
      var all = items && items.value;
      if (all && typeof all.forEach === 'function') {
        var found = '';
        all.forEach(function(it){
          if (!found && it && it.sessionId && it.sessionId.value === id) found = (it.summary && it.summary.value) || '';
        });
        return String(found || '');
      }
    } catch (e) { /* no title */ }
    return '';
  };

  // The menu item for the selected archived conversations, after Unarchive; null leaves the menu as it is. Remote
  // conversations are not on this machine's disk and are left out.
  window.__cceDeleteItem = function(keys){
    try {
      if (isOff('deleteArchived') || !Array.isArray(keys)) return null;
      var ids = keys.filter(function(k){ return typeof k === 'string' && DELETE_ID.test(k); });
      if (!ids.length) return null;
      return {
        label: ids.length > 1 ? 'Delete ' + ids.length + ' sessions…' : 'Delete session…',
        separatorBefore: true,
        onSelect: function(){
          try {
            acquireVsCodeApi().postMessage({ type: 'cce_delete_sessions', sessions: ids.map(function(id){ return { id: id, title: deleteTitle(id) }; }) });
          } catch (e) { /* nothing is deleted */ }
        },
      };
    } catch (e) { return null; }
  };

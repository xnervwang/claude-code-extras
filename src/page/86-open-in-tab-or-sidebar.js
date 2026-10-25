// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Choosing where a conversation opens, from the session list: two buttons in place of New session, one for a new tab and
// one for the sidebar, and the same two choices in place of Resume session for a conversation that is not open.
// Fragment of the in-page script - see README.md in this folder.

  // Both go to this extension, which asks Claude Code's open command the way its own programmatic opens do, so neither
  // changes claudeCode.preferredLocation. The tab bar's Claude button is left alone and keeps following that setting.
  // A conversation that is open is shown where it is: the menu offers only Claude Code's own Switch to session for it.
  var OPEN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var openIn = function(where, sessionId){
    try {
      acquireVsCodeApi().postMessage({ type: 'cce_open_session', where: where, sessionId: sessionId });
      return true;
    } catch (e) { return false; }
  };

  // The panel draws these with its own factories and classes, in place of its New session button; null leaves that
  // button as it is.
  window.__cceNewSessionButtons = function(ui){
    try {
      if (isOff('openInTabOrSidebar') || !ui || typeof ui.jsx !== 'function' || typeof ui.jsxs !== 'function') return null;
      var F = ui.jsx, W = ui.jsxs, c = ui.cls || {};
      // Two halves of the row the one button filled, parted by the row's own border colour.
      var button = function(where, label, title, parted){
        var style = { flex: '1 1 0', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' };
        if (parted) style.borderLeft = '1px solid var(--app-primary-border-color)';
        return W('button', {
          className: c.newSessionButton || '', style: style, title: title,
          'data-cce-new-session': where,
          onClick: function(){ openIn(where, void 0); },
          children: [ui.Icon ? F(ui.Icon, { className: c.newSessionIcon || '' }) : null, label],
        }, where);
      };
      return W('div', { style: { display: 'flex', alignSelf: 'stretch', flex: '1 1 auto', minWidth: 0 }, children: [
        button('tab', 'New in tab', 'Start a conversation in a new editor tab', false),
        button('sidebar', 'New in sidebar', 'Start a conversation in the sidebar', true),
      ] });
    } catch (e) { return null; }
  };

  // The menu items for one conversation that is not open, in place of Resume session; null keeps Resume session. A
  // remote conversation keeps it, since only a local one can be opened in the sidebar this way.
  window.__cceResumeItems = function(key){
    try {
      if (isOff('openInTabOrSidebar') || typeof key !== 'string' || !OPEN_SESSION_ID.test(key)) return null;
      return [
        { label: 'Resume in tab', onSelect: function(){ openIn('tab', key); } },
        { label: 'Resume in sidebar', onSelect: function(){ openIn('sidebar', key); } },
      ];
    } catch (e) { return null; }
  };

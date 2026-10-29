// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The session list's search box also finds a conversation by part of its session ID.
// Fragment of the in-page script - see README.md in this folder.

  // Claude Code's own filter matches the title and the git branch; an edit in src/webview.js asks this as a third test.
  // A session ID is hexadecimal, so a short query made of the letters a to f and digits ("de", "add") would match the
  // IDs of most conversations and bury the titles it was typed for. The ID is tested only for a query that can be read
  // as part of an ID and is long enough that a match by chance is rare: at four hex digits, about one conversation in
  // two thousand.
  var ID_SEARCH_MIN = 4;
  window.__cceIdMatch = function(session, query){
    try {
      if (isOff('sessionIdSearch')) return false;
      var q = String(query || '').trim().toLowerCase();
      if (q.length < ID_SEARCH_MIN || !/^[0-9a-f-]+$/.test(q)) return false;
      var id = session && session.sessionId && session.sessionId.value;
      return typeof id === 'string' && id.toLowerCase().indexOf(q) >= 0;
    } catch (e) { return false; }
  };

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Finding the session, naming sub-agents, walking the React tree.
// Fragment of the in-page script - see README.md in this folder.

  var agentOf = function(m){
    if (!m || typeof m !== 'object') return '';
    var v = m.parentToolUseId || m.sdkParentToolUseId || m.agentId || m.taskId;
    return typeof v === 'string' ? v : '';
  };
  // toolUseId -> spawn description. The session is located by its own walk rather than inside the hot loop below, so
  // that loop keeps its early exit; the index is rebuilt only when the task table object is replaced.
  var sessionRef = null, titles = new Map(), srcMap = null, srcTasks = null, KNOWN = [];
  var findSession = function(el){
    for (var f = fiber(el), i = 0; f && i < 60; f = f.return, i++) {
      var pr = f.memoizedProps;
      if (pr && typeof pr === 'object' && pr.session && pr.session.agentMapAgents) return pr.session;
    }
    return null;
  };
  /*
   * The conversation the panel is showing. One panel shows one conversation at a time but moves between them - New and
   * Resume in the sidebar switch it in place - so the sweep looks the session up again every time, and when it is
   * another one, everything kept about the one before goes: its sub-agents' names, its chime state, its context
   * breakdown, its efforts, a view of one of its sub-agents, the info box about it, and the marks worked out against it.
   */
  var useSession = function(s){
    var was = sessionRef;
    sessionRef = s;
    if (!was) return;
    titles = new Map(); KNOWN = []; srcMap = srcTasks = null;
    try { primeIdle(); } catch (e) {}
    try { forgetCtx(); } catch (e) {}
    try { resetEfforts(); } catch (e) {}
    try { leaveView(); } catch (e) {}
    try { closeInfo(); } catch (e) {}
    try { resetMarks(); } catch (e) {}
    bgCountsAt = 0; jumpIdx = -1;
  };
  var harvest = function(m){
    if (!m || typeof m.values !== 'function') return;
    for (var it = m.values(), s = it.next(); !s.done; s = it.next()) {
      var t = s.value;
      if (!t || typeof t !== 'object') continue;
      if (typeof t.toolUseId === 'string' && KNOWN.indexOf(t.toolUseId) === -1) KNOWN.push(t.toolUseId);
      if (typeof t.description !== 'string' || !t.description) continue;
      var ids = [t.toolUseId].concat(t.wakeToolUseIds || []);
      for (var n = 0; n < ids.length; n++) if (typeof ids[n] === 'string') titles.set(ids[n], t.description);
    }
  };
  var indexTitles = function(session){
    // The agent map keeps entries for finished agents; the active task table deletes them on
    // completion. Read both so a finished agent still resolves to its name instead of a hash.
    var m = session.agentMapAgents && session.agentMapAgents.value;
    var t = session.subagentTasks && session.subagentTasks.value;
    if (m === srcMap && t === srcTasks) return;
    srcMap = m; srcTasks = t;
    titles = new Map();
    KNOWN = [];
    harvest(t);
    harvest(m);
  };
  var CAP = 18;
  var agentTag = function(id){
    if (!id) return '';
    var d = titles.get(id);
    if (typeof d === 'string' && d) return ' #' + (d.length > CAP ? d.slice(0, CAP) + '..' : d);
    return ' #' + id.slice(-6);
  };
  var fiber = function(el){ for (var k in el) if (k.indexOf('__reactFiber$') === 0) return el[k]; return null; };
  var ctxOf = function(el){
    var out = { block: null, message: null };
    for (var f = fiber(el), i = 0; f && i < 40 && !out.message; f = f.return, i++) {
      var pr = f.memoizedProps;
      if (!pr || typeof pr !== 'object') continue;
      if (!out.block && pr.content && typeof pr.content === 'object' && pr.content.content) out.block = pr.content;
      if (pr.message && typeof pr.message.timestamp === 'number') out.message = pr.message;
    }
    WALK.fiber += i;
    return out;
  };

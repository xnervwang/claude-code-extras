// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The sweep itself, and what starts it. Runs last, so every function it calls is assigned.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * The directory row already built for a message of yours, kept against the block it was read from.
   *
   * A message that is not the newest cannot change its text, its time or its place again, so building its row a second
   * time can only produce the same answer. Keeping it removes a closure, a walk for its text and an object from every
   * sweep for every message you have ever sent - which at four sweeps a second is the part that grew with the length of
   * the conversation. Weak, so nothing is held after the panel drops the block.
   */
  var PROMPT_OF = new WeakMap();

  var stamp = function(){
    if (!isOn()) { sweep(); return; }
    var tA = clock(), wF = WALK.fiber, wT = WALK.text;
    var bubbles = document.querySelectorAll(USER), groups = new Map();
    // The footer is the seed of last resort, and the only one a conversation with no messages in it has: the session
    // object is a prop of the footer toolbar too. Without it an empty conversation has no session at all, which costs
    // the info button its session id and the chimes their signals until the first message arrives.
    if (!sessionRef) {
      var seed = bubbles[0] || document.querySelector(ASSIST) || document.querySelector(SEND);
      if (seed) sessionRef = findSession(seed);
    }
    if (sessionRef) indexTitles(sessionRef);
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i], c = ctxOf(b);
      /* Your own side carries blocks too, and a tool result is recorded as something you said. Labelling here costs
         nothing - the context is already in hand - and without it the bulkiest thing the plain view exists to remove
         would be the one thing it could not reach. A block of your own text is labelled `text` and stays. */
      applyKind(b, c.block && c.block.content && c.block.content.type);
      if (!c.message) continue;
      var g = groups.get(c.message); if (!g) { g = []; groups.set(c.message, g); }
      g.push(b);
    }
    var tB = clock();
    var prompts = [], lastBubble = bubbles.length ? bubbles[bubbles.length - 1] : null;
    groups.forEach(function(list, m){
      /*
       * One row for each thing you said, not one for each message you sent.
       *
       * Send two lines in quick succession and they arrive as a single message carrying two blocks of text - the panel
       * draws a box for each, so two appear on screen. Marking the message rather than the blocks then gave the first
       * box a time and left the second without one, and put a single row in the list of your messages for the two. The
       * replies have always been marked per block, so this is the side that was out of step.
       *
       * Only the newest message is built; the rest are recalled against the block they were read from. What still
       * happens for every block on every sweep is the mark and the owner, and neither is optional: the set of marked
       * elements is rebuilt each sweep and anything missing from it has its mark stripped, and a view switch reaches a
       * message only through applyOwner.
       */
      var live = list.indexOf(lastBubble) >= 0, mark = '';
      for (var bi = 0; bi < list.length; bi++) {
        var b = list[bi];
        applyOwner(b, 'main');
        var row = live ? null : PROMPT_OF.get(b);
        if (!row) {
          var line = textOf(b, b === lastBubble);
          // An attachment or an image carries no line, so it gets no row - and a message that is only an attachment
          // keeps its mark through the block below rather than being skipped altogether.
          row = { node: b, top: b, ts: m.timestamp, text: line, mark: '' };
          if (!live) PROMPT_OF.set(b, row);
        }
        if (live || !row.mark) {
          if (!mark) {
            mark = isOff('timestamps') ? '' : fmt(m.timestamp);
            if (!isOff('subAgentTags')) mark += agentTag(agentOf(m));
          }
          row.mark = mark;
        }
        set(b, row.mark);
        if (row.text) prompts.push(row);
      }
    });
    var promptTs = [], ordered = true;
    for (var pi = 0; pi < prompts.length; pi++) {
      var pts = prompts[pi].ts;
      if (typeof pts !== 'number') continue;
      if (promptTs.length && pts < promptTs[promptTs.length - 1]) ordered = false;
      promptTs.push(pts);
    }
    /* Document order is the order they were sent in, so this is sorted already and the sort was work with no result.
       The check stays because the binary search in turnStartFor depends on the order: an assumption that quietly stopped
       holding would hand every reply the wrong turn start, with nothing to show it had. */
    if (!ordered) promptTs.sort(function(a, b){ return a - b; });
    var tC = clock();
    var msgs = document.querySelectorAll(ASSIST);
    // Both are already in hand, so aiming the text observer costs one walk up to the scrolling ancestor and a compare.
    aimText(bubbles[0] || msgs[0]);
    var seen = [], seenSet = {}, shownRows = 0, fullMsgs = 0, settledMsgs = 0, blocks = 0;
    var agentView = (VIEW !== 'all' && VIEW !== 'main'), acts = [];
    for (var j = 0; j < msgs.length; j++) {
      // A reply well behind the newest one cannot change again: its time, duration and figures are fixed, and its
      // owner is already recorded on the element. Re-deriving all of that on every sweep is the one cost that would
      // grow with the length of the conversation, so such a message is handed its marks once and from then on only
      // has its visibility refreshed - which is all a view switch needs.
      if (j < msgs.length - LIVE_TAIL) {
        var own0 = msgs[j].getAttribute(OWNER_ATTR);
        if (own0) {
          applyOwner(msgs[j], own0);
          if (own0 !== 'main' && !seenSet[own0]) { seenSet[own0] = 1; seen.push(own0); }
          if (ownerVisible(own0)) shownRows++;
          if (msgs[j].getAttribute(SETTLED_ATTR) !== '1') {
            var held = msgs[j].querySelectorAll('[' + ATTR + ']');
            for (var q = 0; q < held.length; q++) marked.delete(held[q]);
            msgs[j].setAttribute(SETTLED_ATTR, '1');
          }
          settledMsgs++;
          continue;
        }
      }
      fullMsgs++;
      var rows = msgs[j].children, ownerDone = false, own = 'main';
      blocks += rows.length;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r], cx = ctxOf(row), v = '';
        if (!ownerDone && cx.message) {
          own = agentOf(cx.message) || 'main';
          applyOwner(msgs[j], own);
          if (own !== 'main' && !seenSet[own]) { seenSet[own] = 1; seen.push(own); }
          if (ownerVisible(own)) shownRows++;
          ownerDone = true;
        }
        /* Whether this row gets an annotation at all, which used to be read off `v` being non-empty. With the time
           itself switchable that test would have made one switch turn four things off, so it is now asked directly. */
        var annot = !!(cx.block && cx.message && cx.message.uuid);
        if (annot) {
          v = isOff('timestamps') ? '' : fmt(cx.message.timestamp);
          var t = cx.block.content && cx.block.content.type;
          // Label the block with its kind while its type is in hand. The plain-conversation filter reads the label off a
          // stylesheet rule, so this is the only place that has to touch the block for it.
          applyKind(row, t);
          if (agentView && own === VIEW && (t === 'tool_use' || t === 'server_tool_use')) {
            acts.push({ node: row, ts: cx.message.timestamp, text: toolLabel(cx.block.content) });
          }
          if (v && (t === 'tool_use' || t === 'server_tool_use') && typeof cx.block.cceResultAt === 'number') v += '\u2192' + fmt(cx.block.cceResultAt).replace(/^\d\d\/\d\d /, '');
        }
        if (annot && !isOff('subAgentTags')) v += agentTag(agentOf(cx.message));
        if (annot && r === 0) {
          var bits = [];
          var t0 = turnStartFor(promptTs, cx.message.timestamp);
          if (t0 !== null && !isOff('replyDuration')) { var d = dur(cx.message.timestamp - t0); if (d) bits.push(d); }
          var st = statAt(cx.message, j === msgs.length - 1);
          if (st) bits.push(st);
          if (bits.length) v += '  ' + bits.join(' ' + String.fromCharCode(183) + ' ');
        }
        set(row, v);
      }
    }
    // Compaction blocks belong to the main thread, so a sub-agent view hides them too.
    var cps = document.querySelectorAll(COMPACT);
    for (var cq = 0; cq < cps.length; cq++) applyOwner(cps[cq], 'main');
    SEEN = seen;
    showNote(VIEW !== 'all' && VIEW !== 'main' && shownRows === 0);
    sweptElements = bubbles.length + msgs.length;
    try { healthCheck(sweptElements); } catch (e) {}
    var tD = clock();
    sweep();
    var tE = clock();
    try { syncMap(agentView ? acts : prompts, cps); } catch (e) {}
    var tF = clock();
    try { ensureViewControl(); } catch (e) {}
    try { ensurePlainControl(); } catch (e) {}
    try { ensureInfo(); } catch (e) {}
    try { orderControls(); } catch (e) {}
    try { wireCtxButton(); } catch (e) {}
    try { watchIdle(); } catch (e) {}
    try { markCtxLow(); } catch (e) {}
    record({ users: tB - tA, prompts: tC - tB, replies: tD - tC, marks: tE - tD, toc: tF - tE,
             controls: clock() - tF, total: clock() - tA,
             bubbles: bubbles.length, msgs: msgs.length, full: fullMsgs, settled: settledMsgs, blocks: blocks,
             fiber: WALK.fiber - wF, text: WALK.text - wT });
  };
  var queued = false, last = 0;
  var sweptElements = 0, firstSweepMs = 0, sweeps = 0, bootAt = 0;
  var clock = function(){ try { return performance.now(); } catch (e) { return 0; } };

  /*
   * What each sweep cost, and where.
   *
   * A sweep runs four times a second for as long as the panel is open, so the question that matters is not how long
   * one took but how much of the main thread all of them together have taken - a figure nothing in the browser's own
   * tools attributes to us, since this code lives inside the panel's bundle. The phases are timed separately because
   * each has a different reason to grow, and a total alone cannot say which one did.
   */
  var PHASES = ['users', 'prompts', 'replies', 'marks', 'toc', 'controls'];
  var LEGEND = {
    users: 'reading your own messages',
    prompts: 'marking them and ordering the turn starts',
    replies: 'reply rows',
    marks: 'taking stale marks off',
    toc: 'the contents list',
    controls: 'the toolbar additions',
  };
  var SLOW_MS = 60;         // a sweep longer than this is a visible stutter, so say so
  var QUIET_MS = 5000;      // ...but at most one complaint per this long, or a freeze prints thousands
  var stats = { n: 0, sum: 0, max: 0, worst: null, last: null, sum_: {}, max_: {} };
  var lastMoan = 0;
  var record = function(s) {
    stats.n++; stats.sum += s.total; stats.last = s;
    for (var i = 0; i < PHASES.length; i++) {
      var k = PHASES[i], v = s[k] || 0;
      stats.sum_[k] = (stats.sum_[k] || 0) + v;
      if (v > (stats.max_[k] || 0)) stats.max_[k] = v;
    }
    if (s.total > stats.max) { stats.max = s.total; stats.worst = s; }
    if (s.total > SLOW_MS && clock() - lastMoan > QUIET_MS) {
      lastMoan = clock();
      try { console.warn('[claude-code-extras] slow sweep ' + Math.round(s.total) + 'ms - ' + where(s)); } catch (e) {}
    }
  };
  /** The phases of one sweep, worst first, so the line names its own culprit. */
  var where = function(s) {
    var out = [];
    for (var i = 0; i < PHASES.length; i++) if ((s[PHASES[i]] || 0) >= 1) out.push({ k: PHASES[i], v: s[PHASES[i]] });
    out.sort(function(a, b){ return b.v - a.v; });
    var bits = out.map(function(p){ return LEGEND[p.k] + ' ' + Math.round(p.v) + 'ms'; });
    bits.push(s.bubbles + ' of your messages, ' + s.msgs + ' replies (' + s.full + ' worked out fully, ' + s.settled + ' already settled)');
    bits.push('steps taken: ' + s.text + ' looking for text lines, ' + s.fiber + ' up React trees');
    return bits.join('; ');
  };
  /*
   * Printed on demand from the panel's devtools console: __cceStats(). The one-line startup report cannot answer
   * "where is the time going" for a conversation that is already open, and this is the only channel a page script
   * has - it has no file system, and the channel to the extension side runs one way.
   */
  window.__cceStats = function() {
    try {
      var up = clock() - T0, rows = [];
      for (var i = 0; i < PHASES.length; i++) {
        var k = PHASES[i];
        rows.push('  ' + LEGEND[k] + ': ' + Math.round(stats.sum_[k] || 0) + 'ms total, worst sweep '
                  + Math.round(stats.max_[k] || 0) + 'ms');
      }
      console.log('[claude-code-extras] ' + stats.n + ' sweeps over ' + (up / 1000).toFixed(1) + 's of panel life\n'
        + '  main thread spent in them: ' + Math.round(stats.sum) + 'ms ('
        + (stats.sum / Math.max(1, up) * 100).toFixed(1) + '% of that time)\n'
        + '  slowest single sweep: ' + Math.round(stats.max) + 'ms\n'
        + '  steps taken in all: ' + WALK.text + ' looking for text lines, ' + WALK.fiber + ' up React trees\n'
        + rows.join('\n')
        + (stats.last ? '\n  latest sweep: ' + where(stats.last) : '')
        + (stats.worst ? '\n  slowest sweep: ' + where(stats.worst) : ''));
      return stats;
    } catch (e) { return null; }
  };
  var run = function(){
    queued = false; last = Date.now();
    var t = clock();
    try { stamp(); } catch (e) {}
    if (sweeps++ === 0) firstSweepMs = clock() - t;
  };
  var schedule = function(){
    if (queued) return; queued = true;
    setTimeout(function(){ requestAnimationFrame(run); }, Math.max(0, 250 - (Date.now() - last)));
  };

  /*
   * Watch for changing text only inside the list the messages are in.
   *
   * It used to be watched on the whole document, which made a sweep out of every character typed into the composer as
   * well as every character streamed into a reply - and a character in the composer cannot change anything about a
   * message that has already been sent. At four sweeps a second against work that grows with the conversation, that is
   * the multiplier rather than any one line inside a sweep.
   *
   * Re-aimed from the sweep rather than bound once, because at boot the list does not exist yet - an empty conversation
   * has no messages at all - and the panel may replace it. The element passed in is one already in hand, so finding the
   * list costs nothing beyond walking up to the scrolling ancestor.
   */
  /*
   * The controls this script adds, in one fixed left-to-right order.
   *
   * Each of them puts itself immediately before the permission-mode selector, so without this their order is whichever
   * was created first - and that changes with what the conversation holds, since the view filter only appears once there
   * is a sub-agent to switch between. The reader would find them somewhere different in each conversation.
   *
   * Nothing is moved while they are already in this order: rearranging the row on a timer would pull a button out from
   * under the pointer, and a click that lands on the wrong control is worse than an order nobody chose.
   */
  var ORDER = ['[data-cce-info]', '[data-cce-plain-btn]', '[data-cce-mute]', '[data-cce-view]'];
  var orderControls = function(){
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    var want = [];
    for (var i = 0; i < ORDER.length; i++) {
      var el = document.querySelector(ORDER[i]);
      if (el && el.parentElement === mode.parentElement) want.push(el);
    }
    if (!want.length) return;
    var placed = true;
    for (var j = 0; j < want.length && placed; j++) {
      placed = (j + 1 < want.length) ? want[j].nextElementSibling === want[j + 1] : want[j].nextElementSibling === mode;
    }
    if (placed) return;
    for (var k = 0; k < want.length; k++) mode.parentElement.insertBefore(want[k], mode);
  };

  /*
   * Label a block the moment it appears, before the browser has painted it.
   *
   * The sweep is throttled to 250ms and labels a block when it gets there, which is correct for everything that reads a
   * label but too late for the one thing that HIDES by it. A tool call is drawn at full height, stands there for up to a
   * quarter second, and then collapses - so a run of them walks the whole conversation up and down, which is unreadable
   * at the rate tool calls arrive.
   *
   * A mutation callback runs at the microtask checkpoint of the task that inserted the node, and painting happens after
   * that task. Labelling here therefore lands before the first paint of that block: it is hidden in the frame it would
   * otherwise have appeared in, and no height ever changes.
   *
   * This does NOT make the throttle looser. It costs one walk up the React tree per element inserted, which is bounded
   * by what arrived rather than by how long the conversation is - the growth the throttle exists to prevent. It is also
   * skipped entirely unless the plain view is switched on, since nothing else needs a label this early.
   *
   * The alternative was hiding blocks that have no label yet, and it was worse in a way worth recording: rows that never
   * get one - the panel's own structure, which carries no block - would have stayed hidden for good, and a sweep that
   * stopped running would empty the conversation instead of merely leaving it unfiltered.
   */
  var labelBlock = function(el){
    var cx = ctxOf(el);
    if (cx.block && cx.block.content) applyKind(el, cx.block.content.type);
  };
  var labelAdded = function(node){
    if (!node || node.nodeType !== 1 || typeof node.matches !== 'function') return;
    // Your own side carries the block on the message element itself; the other side carries one per child.
    if (node.matches(USER)) { labelBlock(node); return; }
    var parent = node.parentElement;
    if (parent && typeof parent.matches === 'function' && parent.matches(ASSIST)) { labelBlock(node); return; }
    // A whole message arriving at once brings its blocks with it.
    if (node.matches(ASSIST)) {
      var kids = node.children;
      for (var i = 0; i < kids.length; i++) labelBlock(kids[i]);
    }
  };
  var onMutations = function(records){
    // Guarded on its own, so a fault here cannot cost the sweep that would have labelled the block anyway.
    try {
      if (plainOn() && !isOff('footerPlainView')) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) labelAdded(added[j]);
        }
      }
    } catch (e) {}
    schedule();
  };

  var aimed = null, aimer = null;
  var aimText = function(anyMessage){
    if (!anyMessage) return;
    var root = scrollerOf(anyMessage) || anyMessage.parentElement;
    if (!root || root === aimed) return;
    if (aimer) aimer.disconnect();
    aimer = new MutationObserver(onMutations);
    aimer.observe(root, { childList: true, subtree: true, characterData: true });
    aimed = root;
  };

  /*
   * One line, once, after the first sweep, into the panel's devtools console. That console is the only place a page
   * script can write - the panel has no file system, and the channel to the extension runs one way - so a question
   * like "why was opening this slow" has to be answered from here. The resource timings are the browser's own, which
   * is what makes the stylesheet's real cost visible rather than guessed at.
   */
  var report = function(){
    try {
      var css, rev, all = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < all.length; i++) {
        var n = String(all[i].name || '');
        if (n.indexOf(LIVE_CSS) !== -1) css = Math.round(all[i].duration);
        else if (n.indexOf(LIVE_REV) !== -1) rev = Math.round(all[i].duration);
      }
      var bits = ['script ran at ' + Math.round(T0) + 'ms', 'started work at ' + Math.round(bootAt) + 'ms',
        'first sweep ' + Math.round(firstSweepMs) + 'ms over ' + sweptElements + ' elements'];
      if (css !== undefined) bits.push('stylesheet ' + css + 'ms');
      if (rev !== undefined) bits.push('revision probe ' + rev + 'ms');
      console.log('[claude-code-extras] ' + bits.join(' | ')
        + '\n  first sweep: ' + (stats.last ? where(stats.last) : 'nothing on the page yet')
        + '\n  call __cceStats() at any time for where the sweeps have spent the main thread since.');
    } catch (e) {}
  };

  /*
   * Startup order. The panel is still laying itself out when this script runs, so everything that reads or watches the
   * page waits for the browser to report itself idle; only the stylesheet goes in straight away, and it no longer
   * blocks painting. Before this, the mutation observer and an immediate first sweep both ran while the first paint was
   * still pending - work the panel had to get through before it could show anything at all.
   */
  /*
   * One line as this script is reached, before anything else, so that a panel that never finishes starting still says
   * where it got to.
   *
   * The report below is the fuller one and is printed after the first sweep - which is no use for a panel that stalls
   * before then: the console is simply empty, and an empty console cannot be told apart from a script that never ran at
   * all. This line distinguishes those two, and its number answers the question directly, because this script is appended
   * AFTER the panel's own code: the time on it is the time the panel's bundle finished evaluating. A panel seen taking 94
   * seconds to send its first message is then settled one way or the other - a large number here means the delay was over
   * before anything of ours existed, and a small one means the bundle was ready early and the wait is further in.
   */
  try {
    console.log('[claude-code-extras] script reached at ' + Math.round(T0)
      + 'ms (panel bundle had finished evaluating by then; this script is appended after it)');
  } catch (e) {}

  reloadCss();
  var booted = false;
  var boot = function(){
    if (booted) return;
    booted = true;
    bootAt = clock();
    /* Structure anywhere on the page, which is what tells us a message arrived, a block opened, or the list itself was
       replaced. Deliberately without characterData: see aimText below. */
    new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true });
    probe();
    setInterval(probe, POLL_MS);
    // The chime and the low-context outline must not depend on DOM churn: a turn can end without
    // any further mutation, which would leave the last sweep observing a still-busy state.
    setInterval(function(){ try { watchIdle(); } catch (e) {} try { markCtxLow(); } catch (e) {} try { ensureMute(); } catch (e) {} try { ensureInfo(); } catch (e) {} try { ensurePlainControl(); } catch (e) {} try { orderControls(); } catch (e) {} }, 700);
    run();
    report();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(boot, { timeout: 1500 });
  else setTimeout(boot, 150);

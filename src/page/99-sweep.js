// The sweep itself, and what starts it. Runs last, so every function it calls is assigned.
// Fragment of the in-page script - see README.md in this folder.

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
      var pick = list.find(function(x){ return textOf(x, x === lastBubble) !== ''; }) || list[0];
      set(pick, fmt(m.timestamp) + agentTag(agentOf(m)));
      /* `pick` is where the text comes from - the first block of the message that has any. `top` is where the message
         starts on screen, which is the first block whatever it holds. They differ whenever a message opens with an
         attachment or an image, and landing on `pick` in that case puts the start of the message above the viewport. */
      prompts.push({ node: pick, top: list[0] || pick, ts: m.timestamp, text: textOf(pick, pick === lastBubble) });
      for (var bi = 0; bi < list.length; bi++) applyOwner(list[bi], 'main');
    });
    var promptTs = [];
    for (var pi = 0; pi < prompts.length; pi++) {
      if (typeof prompts[pi].ts === 'number') promptTs.push(prompts[pi].ts);
    }
    promptTs.sort(function(a, b){ return a - b; });
    var tC = clock();
    var msgs = document.querySelectorAll(ASSIST);
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
        if (cx.block && cx.message && cx.message.uuid) {
          v = fmt(cx.message.timestamp);
          var t = cx.block.content && cx.block.content.type;
          // Label the block with its kind while its type is in hand. The plain-conversation filter reads the label off a
          // stylesheet rule, so this is the only place that has to touch the block for it.
          applyKind(row, t);
          if (agentView && own === VIEW && (t === 'tool_use' || t === 'server_tool_use')) {
            acts.push({ node: row, ts: cx.message.timestamp, text: toolLabel(cx.block.content) });
          }
          if (v && (t === 'tool_use' || t === 'server_tool_use') && typeof cx.block.cceResultAt === 'number') v += '\u2192' + fmt(cx.block.cceResultAt).replace(/^\d\d\/\d\d /, '');
        }
        if (v) v += agentTag(agentOf(cx.message));
        if (v && r === 0) {
          var bits = [];
          var t0 = turnStartFor(promptTs, cx.message.timestamp);
          if (t0 !== null) { var d = dur(cx.message.timestamp - t0); if (d) bits.push(d); }
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
  reloadCss();
  var booted = false;
  var boot = function(){
    if (booted) return;
    booted = true;
    bootAt = clock();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    probe();
    setInterval(probe, POLL_MS);
    // The chime and the low-context outline must not depend on DOM churn: a turn can end without
    // any further mutation, which would leave the last sweep observing a still-busy state.
    setInterval(function(){ try { watchIdle(); } catch (e) {} try { markCtxLow(); } catch (e) {} try { ensureMute(); } catch (e) {} try { ensureInfo(); } catch (e) {} try { ensurePlainControl(); } catch (e) {} }, 700);
    run();
    report();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(boot, { timeout: 1500 });
  else setTimeout(boot, 150);

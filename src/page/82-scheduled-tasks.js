// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// This session's scheduled prompts and the detached sessions it started, as sections of the official agent map.
// Fragment of the in-page script - see README.md in this folder.

  // Everything here runs inside the panel's own render, so a throw would take the dialog - and on past evidence the
  // whole page - down with it. Every entry point returns a harmless value instead.
  //
  // The extension host reads the task files and hands them over through the live stylesheet, base64 in a custom
  // property, because a prompt is full of quotes and newlines that a stylesheet would not carry as-is.
  var decoded = {};
  var readProp = function(name){
    var raw = '';
    try { raw = String(getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim(); }
    catch (e) { return []; }
    var was = decoded[name];
    if (was && was.raw === raw) return was.list;
    var list = [];
    var packed = raw.replace(/^["']/, '').replace(/["']$/, '');
    if (packed.length > 3) {
      try {
        // base64 decodes to one byte per character, and a prompt is not ASCII, so the bytes are read back as UTF-8.
        var bin = atob(packed), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed && parsed.length) list = parsed;
      } catch (e) {}
    }
    decoded[name] = { raw: raw, list: list };
    return list;
  };
  var allSchedules = function(){ return readProp('--cce-schedule'); };

  // A task names the session that created it, which is how a panel tells its own from every other one on the machine.
  var mySchedules = function(){
    var sid = sigValue('sessionId');
    if (!sid) return [];
    var all = allSchedules(), out = [];
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].session === sid) out.push(all[i]);
    return out;
  };

  var pad2 = function(s){ return String(s).length < 2 ? '0' + s : String(s); };
  /*
   * A reading of the schedule, or the expression as written. An expression this cannot read is shown verbatim: a wrong
   * plain-English reading would be worse than none, since the reader has no way to tell one from the other.
   *
   * The list form gets its own case because it is how a repeating gap is moved off the hour. A step of twenty in the
   * minute field can only fire at :00, :20 and :40, so the same twenty minutes shifted seven past the hour has to be
   * spelled out as `7,27,47`. (The step syntax itself is not written out here: the two characters that open it would
   * close this comment.)
   *
   * The gap is reported only when every gap matches, the wrap from the last minute of one hour to the first of the next
   * included. That last one is what makes the reading true rather than merely plausible: `5,25,40` looks evenly spaced
   * from inside the hour and is not, because the wrap is 25. Requiring it also means a reported gap always divides 60,
   * which is a property of the field itself - its pattern repeats every hour - and not a limit of this reading.
   */
  var minuteList = function(field){
    if (!/^\d+(,\d+)+$/.test(field)) return null;
    var parts = field.split(','), mins = [], i;
    for (i = 0; i < parts.length; i++) {
      var n = Number(parts[i]);
      if (!isFinite(n) || n < 0 || n > 59 || mins.indexOf(n) !== -1) return null;
      mins.push(n);
    }
    mins.sort(function(a, b){ return a - b; });
    return mins;
  };
  var evenGap = function(mins){
    var gap = 60 - mins[mins.length - 1] + mins[0];
    for (var i = 1; i < mins.length; i++) if (mins[i] - mins[i - 1] !== gap) return 0;
    return gap;
  };
  var cronText = function(cron){
    var c = String(cron || '').trim(), m;
    if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(c))) return 'every ' + m[1] + ' min';
    if ((m = /^(\d+) \* \* \* \*$/.exec(c))) return 'hourly at :' + pad2(m[1]);
    if ((m = /^(\d+) (\d+) \* \* \*$/.exec(c))) return 'daily at ' + m[2] + ':' + pad2(m[1]);
    if ((m = /^([\d,]+) \* \* \* \*$/.exec(c))) {
      var mins = minuteList(m[1]);
      if (mins) {
        var gap = evenGap(mins);
        if (gap) return 'every ' + gap + ' min';
        var at = [];
        for (var i = 0; i < mins.length; i++) at.push(':' + pad2(mins[i]));
        return 'hourly at ' + at.join(', ');
      }
    }
    return c || 'unknown interval';
  };
  var agoText = function(ms){
    if (typeof ms !== 'number' || !isFinite(ms)) return 'never';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 0) return 'just now';
    if (s < 90) return s + 's ago';
    var mins = Math.round(s / 60);
    if (mins < 90) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    return hrs < 36 ? hrs + 'h ago' : Math.round(hrs / 24) + 'd ago';
  };

  // The panel's own secondary foreground, the same variable its agent and background-task headings use.
  var DIM = 'var(--app-secondary-foreground, var(--vscode-descriptionForeground, #9aa))';
  var scheduleRow = function(h, t){
    return h('details', { style: { margin: '5px 0' }, children: [
      h('summary', { style: { cursor: 'pointer', listStyle: 'revert' }, children: [
        h('span', { children: [cronText(t.cron)] }),
        h('span', { style: { color: DIM }, children: [' · last fired ' + agoText(t.lastFiredAt)] }),
        h('span', { style: { color: DIM, opacity: '0.7', marginLeft: '6px' }, children: [t.id || ''] }),
      ] }),
      h('pre', {
        style: {
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          margin: '6px 0 0', padding: '8px', maxHeight: '240px', overflowY: 'auto',
          fontSize: '0.92em', lineHeight: '1.5', borderRadius: '4px',
          background: 'var(--vscode-textCodeBlock-background, rgba(255,255,255,0.05))',
        },
        children: [t.prompt || '(the prompt was not recorded)'],
      }),
    ] });
  };

  // The heading deliberately mirrors the dialog's other two - "N agents · click an agent for details" and the
  // background-task one: same colour, same size, same weight, one line. Anything heavier reads as a title ABOVE those
  // sections rather than a sibling of them, and then the agents and tasks below look like they belong to it.
  var IDLE_NOTE = 'The interval is a floor on the wait, not a timetable: the prompt is delivered at the first idle '
                + 'moment after it comes due, so a conversation that stays busy pushes it back indefinitely.';
  var scheduleSection = function(h, list){
    var kids = [h('div', {
      style: { color: DIM, fontSize: '1em', marginBottom: '4px' },
      title: IDLE_NOTE,
      children: [list.length + (list.length === 1 ? ' scheduled prompt' : ' scheduled prompts')
               + ' · delivered only while the conversation is idle'],
    })];
    for (var i = 0; i < list.length; i++) kids.push(scheduleRow(h, list[i]));
    return h('div', { style: { marginBottom: '16px' }, children: kids });
  };

  /*
   * The detached sessions this conversation started with `claude --bg`, which the extension host finds in the
   * conversation's transcript and hands over the same way as the schedules.
   *
   * Opening one here is deliberately not offered. The panel starts Claude on any conversation it opens, so opening a
   * session that its own process is still writing would put a second process on it. What is offered instead is the
   * command that attaches to it from a terminal, which is the CLI's own way in.
   *
   * A session that has finished stays listed with how it ended, as the panel does for its own agents: the result is the
   * thing most worth reading, and a list that dropped finished sessions could not tell "done" from "never started".
   */
  var myBackground = function(){
    if (isOff('backgroundSessions')) return [];
    var sid = sigValue('sessionId');
    if (!sid) return [];
    var all = readProp('--cce-background'), out = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b && b.session === sid && typeof b.state === 'string' && b.state && /^[0-9a-f]{8}$/.test(b.id || '')) out.push(b);
    }
    return out;
  };
  var bgLive = function(b){ return b.state === 'working' || b.state === 'blocked'; };
  var BG_WARN = 'var(--vscode-editorWarning-foreground, #cca700)';
  var BG_ERR = 'var(--vscode-errorForeground, #f48771)';
  var BG_STATE = { working: 'running', blocked: 'waiting for you', done: 'done', stopped: 'stopped', failed: 'failed' };
  var SECTION_PRE = {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    margin: '6px 0 0', padding: '8px', maxHeight: '200px', overflowY: 'auto',
    fontSize: '0.92em', lineHeight: '1.5', borderRadius: '4px',
    background: 'var(--vscode-textCodeBlock-background, rgba(255,255,255,0.05))',
  };
  var bgSpan = function(ms){
    if (!(ms > 0)) return '';
    var m = Math.round(ms / 60000);
    if (m < 1) return 'under a minute';
    if (m < 90) return m + ' min';
    var hr = Math.round(m / 60);
    return hr < 36 ? hr + 'h' : Math.round(hr / 24) + 'd';
  };
  var bgWhen = function(b){
    if (bgLive(b)) return b.startedAt ? 'for ' + bgSpan(Date.now() - b.startedAt) : '';
    return b.endedAt ? agoText(b.endedAt) : '';
  };
  var bgTokens = function(n){ return typeof n === 'number' && n > 0 ? Math.round(n / 1000) + 'k tokens' : ''; };
  // Only an attribute and an inline style change on the button. It is an element of the panel's own render, and
  // putting anything inside one of those is what once made the panel's next render throw and leave the page dead.
  var bgCopy = function(el, text){
    try {
      if (!el || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(text).then(function(){
        el.style.opacity = '0.5';
        el.setAttribute('title', 'Copied');
        setTimeout(function(){ el.style.opacity = ''; el.setAttribute('title', 'Copy to the clipboard'); }, 900);
      }, function(){});
    } catch (e) {}
  };
  var bgButton = function(h, text){
    return h('button', {
      type: 'button', title: 'Copy to the clipboard',
      style: {
        cursor: 'pointer', font: 'inherit', fontSize: '0.92em', padding: '2px 8px', borderRadius: '4px',
        color: 'inherit', background: 'transparent', border: '1px solid var(--app-input-border, rgba(128,128,128,0.4))',
      },
      onClick: function(ev){ try { ev.stopPropagation(); } catch (e) {} bgCopy(ev && ev.currentTarget, text); },
      children: [text],
    });
  };
  var bgRow = function(h, b){
    var body = [];
    if (b.state === 'blocked' && b.needs) {
      body.push(h('div', { style: { color: BG_WARN, margin: '6px 0' }, children: ['Waiting for you: ' + b.needs] }));
    }
    if (b.state === 'working' && b.detail) {
      var tk = bgTokens(b.tokens);
      body.push(h('div', { style: { margin: '6px 0' }, children: [b.detail + (tk ? ' · ' + tk : '')] }));
    }
    if (!bgLive(b)) body.push(h('pre', { style: SECTION_PRE, children: [b.result || 'No result was recorded.'] }));
    if (b.task) {
      body.push(h('details', { style: { margin: '6px 0' }, children: [
        h('summary', { style: { cursor: 'pointer', listStyle: 'revert', color: DIM }, children: ['Task'] }),
        h('pre', { style: SECTION_PRE, children: [b.task] }),
      ] }));
    }
    body.push(h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }, children: [
      bgButton(h, 'claude attach ' + b.id), bgButton(h, 'claude logs ' + b.id),
    ] }));
    var at = bgWhen(b);
    var tone = b.state === 'blocked' ? BG_WARN : b.state === 'failed' ? BG_ERR : bgLive(b) ? 'inherit' : DIM;
    return h('details', { style: { margin: '5px 0' }, children: [
      h('summary', { style: { cursor: 'pointer', listStyle: 'revert' }, children: [
        h('span', { children: [b.name || b.id] }),
        h('span', { style: { color: tone }, children: [' · ' + (BG_STATE[b.state] || b.state)] }),
        h('span', { style: { color: DIM }, children: [at ? ' · ' + at : ''] }),
        h('span', { style: { color: DIM, opacity: '0.7', marginLeft: '6px' }, children: [b.id] }),
      ] }),
    ].concat(body) });
  };
  var BG_NOTE = 'Sessions this conversation started with claude --bg. Each runs in its own process; attach to one '
              + 'from a terminal with the command under it.';
  var bgSection = function(h, list){
    var kids = [h('div', {
      style: { color: DIM, fontSize: '1em', marginBottom: '4px' },
      title: BG_NOTE,
      children: [list.length + (list.length === 1 ? ' background session' : ' background sessions')
               + ' · started from this conversation'],
    })];
    // Newest first: the one just launched is the one being looked for.
    for (var i = list.length - 1; i >= 0; i--) kids.push(bgRow(h, list[i]));
    return h('div', { style: { marginBottom: '16px' }, children: kids });
  };

  // Called by the panel with its own element factory, so this returns a real element tree rather than text. null is how
  // a child says it has nothing to add, which is the ordinary case.
  window.__cceSchedule = function(h){
    try {
      if (typeof h !== 'function') return null;
      var parts = [];
      var sched = mySchedules();
      if (sched.length) parts.push(scheduleSection(h, sched));
      var bgs = myBackground();
      if (bgs.length) parts.push(bgSection(h, bgs));
      if (!parts.length) return null;
      return parts.length === 1 ? parts[0] : h('div', { children: parts });
    } catch (e) { return null; }
  };

  // The footer asks for these on every one of its renders, so the answer is held briefly rather than recomputed each time.
  var bgCountsAt = 0, bgCounts = { timers: 0, bg: 0, live: 0, waiting: 0 };
  var ourCounts = function(){
    var now = Date.now();
    if (now - bgCountsAt < 500) return bgCounts;
    bgCountsAt = now;
    var bgs = myBackground(), live = 0, waiting = 0;
    for (var i = 0; i < bgs.length; i++) {
      if (bgLive(bgs[i])) live++;
      if (bgs[i].state === 'blocked') waiting++;
    }
    bgCounts = { timers: mySchedules().length, bg: bgs.length, live: live, waiting: waiting };
    return bgCounts;
  };
  // Opens the footer button: anything of ours to show is reason enough, finished sessions included, since their results
  // are what someone comes to read.
  window.__cceScheduleCount = function(){
    try { var c = ourCounts(); return c.timers + c.bg; } catch (e) { return 0; }
  };

  // The button's own label counts agents, so on a session with only our kinds it would read "0 agents". Detached
  // sessions are counted while they run or wait; finished ones are named only when nothing else would be.
  window.__cceAgentsLabel = function(official, count){
    try {
      if (typeof official !== 'string') return official;
      var c = ourCounts(), extra = [];
      if (c.timers) extra.push(c.timers + (c.timers === 1 ? ' timer' : ' timers'));
      if (c.live) extra.push(c.live + ' bg' + (c.waiting ? ' (' + c.waiting + ' waiting)' : ''));
      else if (c.bg && !(count > 0) && !c.timers) extra.push(c.bg + ' bg done');
      if (!extra.length) return official;
      return count > 0 ? official + ' · ' + extra.join(' · ') : extra.join(' · ');
    } catch (e) { return official; }
  };

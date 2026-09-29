// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// This session's scheduled prompts, shown as a section of the official agent map.
// Fragment of the in-page script - see README.md in this folder.

  // Everything here runs inside the panel's own render, so a throw would take the dialog - and on past evidence the
  // whole page - down with it. Every entry point returns a harmless value instead.
  //
  // The extension host reads the task files and hands them over through the live stylesheet, base64 in a custom
  // property, because a prompt is full of quotes and newlines that a stylesheet would not carry as-is.
  var schedRaw = null, schedList = [];
  var allSchedules = function(){
    var raw = '';
    try { raw = String(getComputedStyle(document.documentElement).getPropertyValue('--cce-schedule') || '').trim(); }
    catch (e) { return []; }
    if (raw === schedRaw) return schedList;
    schedRaw = raw;
    schedList = [];
    var packed = raw.replace(/^["']/, '').replace(/["']$/, '');
    if (packed.length > 3) {
      try {
        // base64 decodes to one byte per character, and a prompt is not ASCII, so the bytes are read back as UTF-8.
        var bin = atob(packed), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed && parsed.length) schedList = parsed;
      } catch (e) {}
    }
    return schedList;
  };

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

  // Called by the panel with its own element factory, so this returns a real element tree rather than text. null is how
  // a child says it has nothing to add, which is the ordinary case.
  //
  // The heading deliberately mirrors the dialog's other two - "N agents · click an agent for details" and the
  // background-task one: same colour, same size, same weight, one line. Anything heavier reads as a title ABOVE those
  // sections rather than a sibling of them, and then the agents and tasks below look like they belong to it.
  var IDLE_NOTE = 'The interval is a floor on the wait, not a timetable: the prompt is delivered at the first idle '
                + 'moment after it comes due, so a conversation that stays busy pushes it back indefinitely.';
  window.__cceSchedule = function(h){
    try {
      if (typeof h !== 'function') return null;
      var list = mySchedules();
      if (!list.length) return null;
      var kids = [h('div', {
        style: { color: DIM, fontSize: '1em', marginBottom: '4px' },
        title: IDLE_NOTE,
        children: [list.length + (list.length === 1 ? ' scheduled prompt' : ' scheduled prompts')
                 + ' · delivered only while the conversation is idle'],
      })];
      for (var i = 0; i < list.length; i++) kids.push(scheduleRow(h, list[i]));
      return h('div', { style: { marginBottom: '16px' }, children: kids });
    } catch (e) { return null; }
  };

  // The footer asks this on every one of its renders, so the answer is held briefly rather than recomputed each time.
  var schedCountAt = 0, schedCount = 0;
  window.__cceScheduleCount = function(){
    try {
      var now = Date.now();
      if (now - schedCountAt < 500) return schedCount;
      schedCountAt = now;
      schedCount = mySchedules().length;
      return schedCount;
    } catch (e) { return 0; }
  };

  // The button's own label counts agents, so on a session with a schedule and no agents it would read "0 agents".
  window.__cceAgentsLabel = function(official, count){
    try {
      if (typeof official !== 'string') return official;
      var n = window.__cceScheduleCount();
      if (!n) return official;
      var timers = n + (n === 1 ? ' timer' : ' timers');
      return count > 0 ? official + ' · ' + timers : timers;
    } catch (e) { return official; }
  };

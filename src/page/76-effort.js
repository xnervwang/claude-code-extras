// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// The effort each reply was sent with.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * The effort each reply was sent with, from the conversation's transcripts.
   *
   * The panel's own effort is the menu's current value, which says nothing about a reply already sent: a setting can
   * pin the effort, a model can lower it, and the menu changes the moment it is clicked. The panel's messages carry no
   * effort at all, so the extension reads the transcripts and writes, per conversation, where the effort changed
   * (src/efforts.js says why it is run starts and not a table). This side walks its replies in order and carries each
   * run forward, owner by owner, since a sub-agent's replies are interleaved with the conversation's and keep runs of
   * their own.
   *
   * A reply past the last one the extension has read gets no effort. Carrying the previous run over it is what would
   * bring the old fault back: the effort that reply used is the one thing not yet known.
   */
  var EFFORT_RUNS = {}, EFFORT_LASTS = {};
  var effortFor = '', effortRev = -1, effortLink = null, effortCarrier = null;
  // The uuids of a reply's rows, kept when it is worked out in full, so a settled reply can still move its owner's run.
  var UUIDS_OF = new WeakMap();
  // Replies labelled while their effort was unknown, worked out again once it arrives. Weak, so a reply the panel has
  // dropped is not held for the sake of a label.
  var effortPending = new WeakSet();

  var hexOf = function(uuid){ return typeof uuid === 'string' ? uuid.replace(/-/g, '') : ''; };
  var parseEfforts = function(raw){
    var runs = {}, lasts = {}, sections = String(raw || '').split(';');
    for (var i = 0; i < sections.length; i++) {
      var parts = sections[i].split('!');
      if (parts.length !== 2 || !parts[1]) continue;
      lasts[parts[1]] = 1;
      var list = parts[0] ? parts[0].split(',') : [];
      for (var k = 0; k < list.length; k++) {
        var kv = list[k].split('=');
        if (kv.length === 2 && kv[0] && /^[a-z]+$/.test(kv[1])) runs[kv[0]] = kv[1];
      }
    }
    return { runs: runs, lasts: lasts };
  };
  var readEfforts = function(){
    if (!effortCarrier || !effortCarrier.isConnected) {
      effortCarrier = document.createElement('div');
      effortCarrier.id = 'cce-effort';
      effortCarrier.style.display = 'none';
      document.body.appendChild(effortCarrier);
    }
    var raw = '';
    try { raw = String(getComputedStyle(effortCarrier).getPropertyValue('--cce-effort') || '').trim(); } catch (e) {}
    var got = parseEfforts(raw.replace(/^["']|["']$/g, ''));
    EFFORT_RUNS = got.runs; EFFORT_LASTS = got.lasts;
    // A settled reply is never labelled again, so the ones labelled without an effort are unsettled for one more pass.
    var msgs = document.querySelectorAll(ASSIST);
    for (var i = 0; i < msgs.length; i++) {
      if (!effortPending.has(msgs[i])) continue;
      msgs[i].removeAttribute(OWNER_ATTR);
      msgs[i].removeAttribute(SETTLED_ATTR);
    }
    effortPending = new WeakSet();
    schedule();
  };
  var loadEfforts = function(rev){
    var sid = sigValue('sessionId');
    if (!base || typeof sid !== 'string' || !/^[0-9a-f-]{36}$/i.test(sid)) return false;
    if (sid !== effortFor) { EFFORT_RUNS = {}; EFFORT_LASTS = {}; }
    effortFor = sid;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = base + EFFORT_PREFIX + sid + '.css?r=' + rev;
    l.onload = function(){
      if (effortLink && effortLink !== l && effortLink.parentNode) effortLink.parentNode.removeChild(effortLink);
      effortLink = l;
      readEfforts();
    };
    // No file yet is the ordinary case for a conversation no window has read: nothing is known, so nothing is shown.
    l.onerror = function(){ if (l.parentNode) l.parentNode.removeChild(l); };
    head.appendChild(l);
    return true;
  };
  /* Called by the revision probe with the image's height, which the extension moves whenever any conversation's
     efforts change. The panel moving to another conversation counts too: that is another file. */
  var effortProbe = function(rev){
    if (isOff('modelName')) return;
    if (rev === effortRev && sigValue('sessionId') === effortFor) return;
    if (loadEfforts(rev)) effortRev = rev;
  };
  /* One reply's effort, moving its owner's run along: a run starting at this reply applies to it, and the last reply
     read closes what is known for that owner. */
  var effortAt = function(state, owner, uuid){
    var s = state[owner] || (state[owner] = { eff: '', done: false });
    var h = hexOf(uuid);
    if (!h) return s.done ? '' : s.eff;
    if (!s.done && EFFORT_RUNS[h]) s.eff = EFFORT_RUNS[h];
    var mine = s.done ? '' : s.eff;
    if (EFFORT_LASTS[h]) s.done = true;
    return mine;
  };

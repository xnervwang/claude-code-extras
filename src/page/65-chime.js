// The three chimes and the mute button.
// Fragment of the in-page script - see README.md in this folder.

  // A short synthesised chime when a turn finishes, so a long run does not need watching.
  // The mute button in the prompt panel toggles it; the choice survives reloads.
  // Three things are worth hearing, and they are told apart by shape rather than by volume, so the ear can name them
  // without looking: a turn finished, Claude is waiting for permission, Claude has asked something. Waiting is the one
  // that matters most - it has stopped and will not move again until you act.
  //
  // Each tone is [frequency, start offset in seconds, length in seconds]. Synthesised, so the extension ships no
  // audio files; and played in the page, which renders on your own machine, so it is heard there even when the editor
  // is attached to a remote host.
  var TONES = {
    done: [[880, 0, 0.09], [1174, 0.09, 0.16]],
    permission: [[880, 0, 0.07], [880, 0.13, 0.07], [880, 0.26, 0.11]],
    question: [[1174, 0, 0.09], [880, 0.10, 0.16]],
  };
  var beep = function(kind){
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      var steps = TONES[kind] || TONES.done;
      var ac = new Ctor(), t0 = ac.currentTime, until = t0;
      for (var i = 0; i < steps.length; i++) {
        var at = t0 + steps[i][1], dur = steps[i][2];
        var osc = ac.createOscillator(), gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(steps[i][0], at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.05, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain); gain.connect(ac.destination);
        osc.start(at); osc.stop(at + dur + 0.02);
        if (at + dur > until) until = at + dur;
      }
      setTimeout(function(){ try { ac.close(); } catch (e) {} }, (until - t0) * 1000 + 400);
    } catch (e) {}
  };
  // Signals are read defensively: a build that renames or drops one of them should cost a chime, not the sweep.
  var sigLen = function(name){
    var s = sessionRef && sessionRef[name], v = s && s.value;
    return (v && typeof v.length === 'number') ? v.length : 0;
  };
  var sigOn = function(name){
    var s = sessionRef && sessionRef[name];
    return !!(s && s.value === true);
  };
  var wasBusy = false, hadPerm = 0, hadDialog = 0, wasWaiting = false;
  // Whether the chimes sound at all, kept in the page's own storage so the choice outlives a reload. Absent means on,
  // so a first-time panel chimes without anything having been written. Both directions swallow their errors: storage
  // can be denied, and a denied read must not take the mute button's paint down with it.
  var CHIME_KEY = 'cce.chime';
  var chimeOn = function(){
    try { return window.localStorage.getItem(CHIME_KEY) !== '0'; } catch (e) { return true; }
  };
  var setChime = function(on){
    try { window.localStorage.setItem(CHIME_KEY, on ? '1' : '0'); } catch (e) {}
  };
  // The chime toggle belongs to the whole session, so it lives in the footer toolbar, immediately
  // left of the permission-mode selector. The send button is the stable anchor: the selector is its
  // previous sibling. React may replace the row, so this is re-checked on the timer below.
  var paintMute = function(){
    if (!MUTE) return;
    var on = chimeOn();
    setStyle(MUTE, 'opacity', on ? '1' : '0.4');
    setStyle(MUTE, 'textDecoration', on ? 'none' : 'line-through');
    setLabel(MUTE, on ? 'A chime when a turn finishes, and when Claude is waiting for you - click to mute'
                      : 'Chimes are muted - click to hear a chime when a turn finishes');
  };
  var ensureMute = function(){
    if (MUTE && MUTE.isConnected) { paintMute(); return; }
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    MUTE = document.createElement('button');
    MUTE.type = 'button';
    MUTE.setAttribute('data-cce-mute', '1');
    MUTE.textContent = String.fromCharCode(9834);
    var proto = document.querySelector('button[class*="menuButton"]');
    if (proto) MUTE.className = proto.className;
    else {
      MUTE.style.background = 'transparent';
      MUTE.style.border = 'none';
      MUTE.style.color = 'var(--vscode-foreground, #ccc)';
      MUTE.style.cursor = 'pointer';
    }
    MUTE.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      setChime(!chimeOn());
      paintMute();
    });
    mode.parentElement.insertBefore(MUTE, mode);
    paintMute();
  };
  var watchIdle = function(){
    if (!sessionRef) return;
    var on = chimeOn();
    var nPerm = sigLen('permissionRequests'), nDialog = sigLen('userDialogRequests'), waiting = sigOn('pendingInput');
    // A rising count is the arrival of something new; pendingInput is the fallback for a build that reports only that.
    if (on && nPerm > hadPerm) beep('permission');
    else if (on && nDialog > hadDialog) beep('question');
    else if (on && waiting && !wasWaiting) beep('question');
    hadPerm = nPerm; hadDialog = nDialog; wasWaiting = waiting;
    var b = sigOn('busy');
    if (on && wasBusy && !b) beep('done');
    wasBusy = b;
  };

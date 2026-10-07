// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Runs in the Claude Code panel, not in Node: src/host.js reads this file and puts it inline in the panel's HTML, ahead
 * of the panel's own bundle. It says when that bundle is slow to arrive or never does.
 *
 * Inline in the HTML because that is the one place that still runs when the panel is blank. The extension host hands the
 * HTML to the editor as text, while every file the panel then asks for - its bundle, its stylesheet, and the script this
 * extension appends to the bundle - is fetched through the editor's service worker. When that fetch never answers, the
 * panel stays empty and nothing riding inside the bundle ever starts, so the injected script cannot see the case that
 * most needs seeing.
 *
 * The report goes out on the panel's own message channel, which does not pass through the service worker either, and
 * Claude Code writes every message a panel sends into its log ("Received message from webview"), with the type and the
 * request id verbatim and everything else reduced to a type name. So the whole report is the request id. Claude Code does
 * not know the type and logs one more line saying so; nothing else happens to the message.
 *
 * Silent when the panel opens in time, which is nearly always: no message, no timer left running.
 */
(function () {
  'use strict';
  var orig = globalThis.acquireVsCodeApi;
  if (typeof orig !== 'function') return;
  /* The editor hands out one handle per panel and throws on a second request, and the panel's bundle asks for one as it
     starts. Both requests go through this, so whichever comes first creates the handle and the other gets the same one -
     the bundle cannot tell the difference, and reporting before it has started cannot break it. */
  var api = null;
  globalThis.acquireVsCodeApi = function () { if (!api) api = orig(); return api; };

  var SLOW_MS = 3000;
  /* A request a service worker has received is answered within 30 s or ended at 5 minutes, so the checks straddle both:
     still pending at 1 minute means no answer is coming from the worker's own timeout, and still pending past 5 means
     the worker never had the request at all. */
  var CHECKS = [15000, 60000, 300000, 600000];
  var MAX_SENT = CHECKS.length + 1;
  // Early enough that the first report already says whether a request made from scratch got an answer.
  var FRESH_AT = 10000;

  var t0 = Date.now();
  var files = { js: null, css: null };
  var readyMs = -1, swChanges = 0, sent = 0, reportedStuck = false, timers = [];
  var fresh = null;

  try {
    var sw = navigator.serviceWorker;
    if (sw) {
      sw.ready.then(function () { readyMs = Date.now() - t0; }, function () {});
      sw.addEventListener('controllerchange', function () { swChanges++; });
    }
  } catch (e) { /* reported as unknown below */ }

  var kindOf = function (url) {
    if (typeof url !== 'string') return '';
    var p = url.split('?')[0];
    if (p.slice(-17) === '/webview/index.js') return 'js';
    if (p.slice(-18) === '/webview/index.css') return 'css';
    return '';
  };
  var where = function () {
    return window.IS_SESSION_LIST_ONLY ? 'list' : window.IS_SIDEBAR ? 'sidebar' : 'tab';
  };
  var controller = function () {
    try {
      var c = navigator.serviceWorker && navigator.serviceWorker.controller;
      return c ? String(c.state) : 'none';
    } catch (e) { return 'unknown'; }
  };
  var fileState = function (f) { return f === null ? 'pending' : (f.ok ? 'ok@' : 'error@') + f.ms; };
  /* The stylesheet is in the head, ahead of this script, so on an ordinary open it has arrived before anything here was
     listening. A finished request leaves a timing entry, so its absence is what pending means. */
  var already = function (kind) {
    if (files[kind] !== null) return;
    try {
      var list = performance.getEntriesByType('resource');
      for (var i = 0; i < list.length; i++) {
        if (kindOf(list[i].name) === kind) { files[kind] = { ok: true, ms: 'before-watch' }; return; }
      }
    } catch (e) { /* stays pending */ }
  };
  /* The browser's own breakdown of a finished request, the numbers the developer tools' Timing tab draws, each counted
     from the moment the request was made. A request that has not finished has no entry yet. */
  var timing = function (kind) {
    try {
      var list = performance.getEntriesByType('resource');
      for (var i = list.length - 1; i >= 0; i--) {
        var e = list[i];
        if (kindOf(e.name) !== kind) continue;
        var from = function (v) { return v ? Math.round(v - e.startTime) + 'ms' : '-'; };
        return kind + '[made=' + Math.round(e.startTime) + 'ms worker=' + from(e.workerStart)
          + ' response=' + from(e.responseStart) + ' end=' + from(e.responseEnd) + ']';
      }
    } catch (x) { /* no timing to give */ }
    return kind + '[-]';
  };

  var send = function (what) {
    if (sent >= MAX_SENT) return;
    sent++;
    already('css');
    var text = what + ' after=' + (Date.now() - t0) + 'ms in=' + where()
      + ' js=' + fileState(files.js) + ' css=' + fileState(files.css)
      + ' sw=' + controller() + ' ready=' + (readyMs < 0 ? 'no' : readyMs + 'ms') + ' swchanges=' + swChanges
      + ' hidden=' + (document.hidden ? 1 : 0)
      + (fresh ? ' fresh=' + (fresh.ms < 0 ? 'pending' : fresh.how + '@' + fresh.ms + 'ms') : '');
    try { globalThis.acquireVsCodeApi().postMessage({ type: 'cce_panel_load', requestId: text }); } catch (e) { /* lost */ }
  };

  /* One request made from scratch when the bundle is already late: whether anything this panel asks for is answered, or
     only the bundle's request got lost. The stylesheet is asked for as an image, which the browser cannot decode, so an
     answer shows up as an error - promptly - and no answer shows up as neither event ever firing. */
  var tryFresh = function () {
    try {
      var link = document.querySelector('link[rel="stylesheet"][href*="index.css"]');
      if (!link || !link.href) return;
      var started = Date.now();
      fresh = { ms: -1, how: '' };
      var img = new Image();
      var settle = function (how) {
        return function () { if (fresh.ms < 0) { fresh.ms = Date.now() - started; fresh.how = how; } };
      };
      img.onload = settle('loaded');
      img.onerror = settle('answered');
      img.src = link.href.split('?')[0] + '?cce-fresh=' + started;
    } catch (e) { fresh = null; }
  };

  var stop = function () { for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]); timers = []; };
  var arrived = function (e, ok) {
    var kind = kindOf(e && e.target && (e.target.src || e.target.href));
    if (!kind || files[kind] !== null) return;
    files[kind] = { ok: ok, ms: (Date.now() - t0) + 'ms' };
    if (kind !== 'js') return;
    stop();
    if (!ok) send('failed ' + timing('js'));
    else if (reportedStuck) send('arrived ' + timing('js') + ' ' + timing('css'));
    else if (Date.now() - t0 >= SLOW_MS) send('slow ' + timing('js') + ' ' + timing('css'));
  };
  /* Load and error do not bubble, but a listener on the document in the capture phase sees them for every element. */
  document.addEventListener('load', function (e) { arrived(e, true); }, true);
  document.addEventListener('error', function (e) { arrived(e, false); }, true);

  timers.push(setTimeout(function () { if (files.js === null) tryFresh(); }, FRESH_AT));
  for (var i = 0; i < CHECKS.length; i++) {
    timers.push(setTimeout(function () {
      if (files.js !== null) return;
      reportedStuck = true;
      send('stuck');
    }, CHECKS[i]));
  }
})();

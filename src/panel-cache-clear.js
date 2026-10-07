// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Runs in the Claude Code panel, not in Node: src/host.js puts it inline at the top of the panel's HTML, ahead of every
 * file the panel asks for. Once per panel origin, it deletes the editor's webview resource caches for that origin.
 *
 * Builds up to 1.0.7 polled a revision image every three seconds at an address that changed each time, and fetched
 * their stylesheets at an address that changed with every revision. The editor's webview service worker keeps a
 * Cache Storage entry for every such address and never trims them, so over weeks one origin's cache grew to millions
 * of entries; a lookup in it then never returned, and every panel of that origin stayed blank, in every window, across
 * restarts. Deleting the cache is what recovers it - the editor creates a fresh one on its next request - and this
 * has to run here, in the HTML, because a panel in that state never gets as far as running its bundle.
 *
 * Done once and remembered in this origin's own storage. If the deletion fails or never finishes, nothing is
 * remembered and the next panel tries again. Later builds delete what they fetch (src/page/05-page-setup.js), so the
 * cache does not grow back.
 */
(function () {
  'use strict';
  var FLAG = 'cce.resourceCacheCleared';
  var DONE = '1';
  try {
    if (localStorage.getItem(FLAG) === DONE) return;
    if (typeof caches === 'undefined' || !caches || !caches.keys) return;
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return String(n).indexOf('vscode-resource-cache-') === 0; })
        .map(function (n) { return caches['delete'](n); }));
    }).then(function () {
      try { localStorage.setItem(FLAG, DONE); } catch (e) { /* tried again next time */ }
    }, function () { /* tried again next time */ });
  } catch (e) { /* no storage here: nothing to clear */ }
})();

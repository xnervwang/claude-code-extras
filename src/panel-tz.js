// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Runs in the Claude Code panel, not in Node: src/host.js puts it inline in the panel's HTML. It tells the extension host
 * which time zone the panel is drawn in.
 *
 * The work plan's tree is drawn by the extension host, and in a remote window that host runs on the remote machine,
 * whose clock is set to its own zone - often UTC - while the conversation beside it shows the reader's local time. The
 * panel is the one part that runs where the reader is, so its zone is the reader's. It goes out on the panel's own
 * message channel; the patched host keeps it in a global this extension reads.
 */
(function () {
  'use strict';
  var orig = globalThis.acquireVsCodeApi;
  if (typeof orig !== 'function') return;
  /* The editor hands out one handle per panel and throws on a second request, and the panel's bundle asks for one as it
     starts. Both requests go through this, so whichever comes first creates the handle and the other gets the same one. */
  var api = null;
  globalThis.acquireVsCodeApi = function () { if (!api) api = orig(); return api; };
  var zone = '';
  try { zone = String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) { return; }
  if (!zone) return;
  try { globalThis.acquireVsCodeApi().postMessage({ type: 'cce_client_tz', timeZone: zone }); } catch (e) { /* lost */ }
})();

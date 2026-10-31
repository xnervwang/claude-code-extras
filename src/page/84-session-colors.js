// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// A text color for a conversation's title in the session list, chosen under Text color in its right-click menu.
// Fragment of the in-page script - see README.md in this folder.

  // The host puts the colors in the live stylesheet as [1, [[session ID, color name], ...]]; src/sessioncolors.js keeps
  // them. The leading 1 keeps the property there when nothing is colored, and the menu offers Text color only while the
  // property is there, since only then does the host act on a choice.
  //
  // The names are those of Claude Code's /color. Each maps to a color variable of the editor's theme, so light, dark
  // and high-contrast themes each pick their own shade. Pink and cyan have no chart color, so they use the terminal's.
  var COLOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var COLOR_NAMES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
  var COLOR_OF = {
    red: 'var(--vscode-charts-red,#f14c4c)',
    blue: 'var(--vscode-charts-blue,#3794ff)',
    green: 'var(--vscode-charts-green,#89d185)',
    yellow: 'var(--vscode-charts-yellow,#cca700)',
    purple: 'var(--vscode-charts-purple,#b180d7)',
    orange: 'var(--vscode-charts-orange,#d18616)',
    pink: 'var(--vscode-terminal-ansiBrightMagenta,#d670d6)',
    cyan: 'var(--vscode-terminal-ansiCyan,#11a8cd)',
  };
  /* How long a choice is shown before the stylesheet confirms it; after that the stylesheet wins, as with a pin
     (83-session-pins.js). */
  var COLOR_WAIT_MS = 15000;
  var colorWait = {};
  var colorStyle = null;
  /* The list's element factory, for the swatches in the menu. The pin code saves it each time it draws a row
     (83-session-pins.js); until then the menu shows the names alone. */
  var listJsx = null;

  var colorsNow = function(){
    var d = readProp('--cce-colors');
    if (!d || d.length !== 2 || d[0] !== 1 || !Array.isArray(d[1])) return null;
    var out = {};
    for (var i = 0; i < d[1].length; i++) {
      var p = d[1][i];
      if (!p || typeof p[0] !== 'string' || !COLOR_ID.test(p[0])) continue;
      if (Object.prototype.hasOwnProperty.call(COLOR_OF, p[1])) out[p[0]] = p[1];
    }
    return out;
  };
  var colorOf = function(id, d){
    var w = colorWait[id];
    if (w && Date.now() - w.at < COLOR_WAIT_MS) return w.name;
    if (w) delete colorWait[id];
    return (d && Object.prototype.hasOwnProperty.call(d, id)) ? d[id] : null;
  };

  /*
   * One rule per colored conversation, for its title in every row that shows it: the list's rows, and those of Open
   * sessions and Recently closed, all have an id ending in the session ID. The `span` makes the rule outrank the list's
   * own color for the open conversation's row, which keeps its bold.
   */
  var paintColors = function(){
    var d = isOff('sessionColors') ? null : colorsNow();
    var css = '';
    if (d) {
      var ids = Object.keys(d).concat(Object.keys(colorWait)).sort();
      for (var i = 0; i < ids.length; i++) {
        if (i && ids[i] === ids[i - 1]) continue;
        var name = colorOf(ids[i], d);
        if (name && COLOR_OF[name]) {
          css += '[class*="sessionItem_"][id$="' + ids[i] + '"] span[class*="sessionName_"]{color:'
            + COLOR_OF[name] + '}';
        }
      }
    }
    if (!css && !colorStyle) return;
    if (!colorStyle) {
      colorStyle = document.createElement('style');
      colorStyle.setAttribute('data-cce-colors', '1');
      head.appendChild(colorStyle);
    }
    if (colorStyle.textContent !== css) colorStyle.textContent = css;
  };

  var sendColor = function(ids, name){
    try { acquireVsCodeApi().postMessage({ type: 'cce_session_color', sessionIds: ids, color: name }); }
    catch (e) { return; }
    var at = Date.now();
    for (var i = 0; i < ids.length; i++) colorWait[ids[i]] = { name: name, at: at };
    paintColors();
    setTimeout(function(){
      try { paintColors(); } catch (e) { /* the next stylesheet draws them */ }
    }, COLOR_WAIT_MS + 100);
  };

  /* A menu entry: a swatch and the name, with a check mark after the current color. Default has an empty ring for a
     swatch. */
  var colorLabel = function(name, current){
    var text = (name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Default') + (current ? ' ✓' : '');
    if (typeof listJsx !== 'function') return text;
    return listJsx('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
      children: [listJsx('span', {
        'aria-hidden': 'true',
        style: {
          flex: 'none', width: '10px', height: '10px', borderRadius: '50%', boxSizing: 'border-box',
          background: name ? COLOR_OF[name] : 'transparent', border: name ? 'none' : '1px solid currentColor',
        },
      }), text],
    });
  };

  // The Text color entry for the selected conversations, with Default and the eight colors under it; null leaves the
  // menu as it is. Remote conversations are skipped, as for Delete: they are not on this machine's disk.
  window.__cceColorItem = function(keys, after){
    try {
      if (isOff('sessionColors') || !Array.isArray(keys)) return null;
      var d = colorsNow();
      if (!d) return null;
      var ids = keys.filter(function(k){ return typeof k === 'string' && COLOR_ID.test(k); });
      if (!ids.length) return null;
      var current = colorOf(ids[0], d);
      for (var i = 1; i < ids.length; i++) if (colorOf(ids[i], d) !== current) { current = void 0; break; }
      var pick = function(name){ return function(){ sendColor(ids, name); }; };
      var sub = [{ label: colorLabel(null, current === null), onSelect: pick(null) }];
      for (var j = 0; j < COLOR_NAMES.length; j++) {
        var n = COLOR_NAMES[j];
        sub.push({ label: colorLabel(n, current === n), separatorBefore: j === 0, onSelect: pick(n) });
      }
      return { label: 'Text color', separatorBefore: !!after, submenu: sub };
    } catch (e) { return null; }
  };

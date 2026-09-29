// Where a row gets its mark, and taking marks away again.
// Fragment of the in-page script - see README.md in this folder.

  var SKIP = /visuallyHidden|screenReader|attachment/i;
  // The search for a message's first line of text is remembered per element, since it is the same answer every
  // time unless the panel rebuilds that part of the tree. Keyed weakly, so nothing is held once the row is gone.
  var lineCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var textLineOf = function(root){
    if (lineCache) {
      var hit = lineCache.get(root);
      if (hit && hit.isConnected && root.contains(hit)) return hit;
    }
    var stack = [root], seen = 0;
    while (stack.length && seen++ < 400) {
      var e = stack.shift();
      if (e !== root && (SKIP.test(String(e.className || '')) || /^(SCRIPT|STYLE|SVG|TEXTAREA)$/i.test(e.tagName || ''))) continue;
      var kids = e.childNodes || [];
      for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 3 && String(kids[i].nodeValue || '').trim() !== '') {
        if (lineCache) lineCache.set(root, e);
        WALK.text += seen;
        return e;
      }
      stack = Array.prototype.slice.call(e.children || []).concat(stack);
    }
    WALK.text += seen;
    return null;
  };
  // Reading a message's text walks its whole subtree, which is costly for a long paste and gives the same answer
  // every time once the message has been sent. Cached weakly; the newest bubble is always re-read since it may
  // still be rendering.
  var textCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var textOf = function(el, live){
    if (!live && textCache) {
      var v = textCache.get(el);
      if (typeof v === 'string') return v;
    }
    var out = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!live && textCache) textCache.set(el, out);
    return out;
  };
  var marked = new Set(), nextMarked = new Set();
  var set = function(el, v){
    if (!v) return;
    var target = textLineOf(el) || el;
    nextMarked.add(target);
    if (target.getAttribute(ATTR) !== v) target.setAttribute(ATTR, v);
  };
  var sweep = function(){
    marked.forEach(function(el){ if (!nextMarked.has(el) && el.hasAttribute && el.hasAttribute(ATTR)) el.removeAttribute(ATTR); });
    marked = nextMarked; nextMarked = new Set();
  };

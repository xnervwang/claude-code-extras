// A toggle that leaves only the conversation: your questions and the replies, without the thinking and the tool calls.
// Fragment of the in-page script - see README.md in this folder.

  /*
   * This is the second of two independent filters, and it stays independent by writing somewhere else.
   *
   * The view filter decides WHOSE messages are shown and writes `display` on the message element. This one decides WHICH
   * KINDS of block are shown, and a block is a child of that element - so the two never write the same property of the
   * same node, and hiding a message still hides everything inside it whatever this says.
   *
   * It hides by stylesheet rather than by walking the blocks. Each block is labelled once, when the sweep derives it
   * anyway; the toggle then edits one rule. Walking instead would mean visiting every block of every message on every
   * sweep - the one cost this extension is not allowed to have, since it grows with the length of the conversation - and
   * it would also miss the messages the sweep has already settled and stopped looking at.
   */
  var KIND_ATTR = 'data-cce-kind';
  var PLAIN_KEY = 'cce.plain';
  // What a conversation is: what was said. Thinking is the reply being composed rather than the reply, and a tool call
  // is the work behind it. `image` stays, because an image someone pasted is part of what they said.
  var NOT_PLAIN = ['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'tool_result'];
  var PLAINBTN = null, plainStyle = null;

  var plainOn = function(){
    try { return window.localStorage.getItem(PLAIN_KEY) === '1'; } catch (e) { return false; }
  };
  var setPlain = function(on){
    try { window.localStorage.setItem(PLAIN_KEY, on ? '1' : '0'); } catch (e) {}
  };

  // Labelling is free: the sweep has already read the block's type to decide what to write on it.
  var applyKind = function(el, type){
    if (typeof type !== 'string' || !type) return;
    if (el.getAttribute(KIND_ATTR) !== type) el.setAttribute(KIND_ATTR, type);
  };

  /*
   * One rule, edited in place. `!important` because the panel sets `display` on some of these blocks itself, and a
   * filter that loses to the thing it is filtering is not a filter.
   *
   * The second half of the rule is about the rail. The dot and the line segment beside a row are the ::before and
   * ::after of the row the panel marks with a `timelineMessage_` class - tool-call headers and fold rows carry it - so
   * hiding a block INSIDE such a row leaves the row itself behind at collapsed height, painting a dot with nothing next
   * to it. The row has to go too.
   *
   * It goes only when it has nothing left worth showing: a row holding a text block as well keeps its place, because
   * there is still something to read there and the dot belongs to it. The class is matched by name pattern rather than
   * in full - the panel's build hashes the suffix, and the same technique is how the panel's own message classes are
   * matched elsewhere in this script.
   */
  var RAIL = '[class*="timelineMessage_"]';
  var paintPlainRule = function(){
    if (!plainStyle) {
      plainStyle = document.createElement('style');
      plainStyle.setAttribute('data-cce-plain', '1');
      (document.head || document.documentElement).appendChild(plainStyle);
    }
    if (!plainOn()) { plainStyle.textContent = ''; return; }
    var sel = [], keep = ':not(:has([' + KIND_ATTR + '="text"]))';
    for (var i = 0; i < NOT_PLAIN.length; i++) {
      var k = '[' + KIND_ATTR + '="' + NOT_PLAIN[i] + '"]';
      sel.push(k);
      sel.push(RAIL + ':has(' + k + ')' + keep);
    }
    plainStyle.textContent = sel.join(',') + '{display:none !important}';
  };

  /*
   * The two states are told apart by the shape of the icon, not by how bright it is.
   *
   * An eye that is open or shut says which one you are in; a single icon at two opacities says it only to someone who
   * remembers what the other one looked like. A speech balloon was worse than either: in a panel that is nothing but a
   * conversation, "conversation" does not pick anything out.
   *
   * The glyphs come from the icon font the panel already embeds, so they follow the theme's colour and the button's own
   * size like every other icon in the editor. The code points were read out of that font's own glyph table rather than
   * copied from a list - a wrong one draws an empty box and nothing else says why.
   */
  var EYE_OPEN = String.fromCharCode(0xEA70), EYE_SHUT = String.fromCharCode(0xEAE7);
  var paintPlain = function(){
    if (!PLAINBTN) return;
    var on = plainOn();
    if (PLAINBTN.textContent !== (on ? EYE_SHUT : EYE_OPEN)) PLAINBTN.textContent = on ? EYE_SHUT : EYE_OPEN;
    setStyle(PLAINBTN, 'opacity', on ? '1' : '0.6');
    setLabel(PLAINBTN, on
      ? 'Showing the conversation only - click to bring back thinking and tool calls'
      : 'Show the conversation only: your messages and the replies, without thinking or tool calls');
  };

  // Same anchor as the other footer controls: the send button's previous sibling is the permission-mode selector, and
  // React may replace that row, so this is re-checked on the timer rather than wired once.
  var ensurePlainControl = function(){
    paintPlainRule();
    if (PLAINBTN && PLAINBTN.isConnected) { paintPlain(); return; }
    var send = document.querySelector(SEND);
    if (!send) return;
    var mode = send.previousElementSibling;
    if (!mode || !mode.parentElement) return;
    PLAINBTN = document.createElement('button');
    PLAINBTN.type = 'button';
    PLAINBTN.setAttribute('data-cce-plain-btn', '1');
    /* The icon font by name rather than by the panel's own `codicon` class: that class appears in a great many rules
       here, each qualified by an ancestor this button does not have, and inheriting whichever of them happened to match
       is not something to rely on. The face is set by paintPlain below. */
    PLAINBTN.style.fontFamily = 'codicon';
    var proto = document.querySelector('button[class*="menuButton"]');
    if (proto) PLAINBTN.className = proto.className;
    else {
      PLAINBTN.style.background = 'transparent';
      PLAINBTN.style.border = 'none';
      PLAINBTN.style.color = 'var(--vscode-foreground, #ccc)';
      PLAINBTN.style.cursor = 'pointer';
    }
    PLAINBTN.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      setPlain(!plainOn());
      paintPlainRule();
      paintPlain();
    });
    mode.parentElement.insertBefore(PLAINBTN, mode);
    paintPlain();
  };

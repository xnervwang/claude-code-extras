// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What Claude Code's panel puts inside a reply, read out of its bundle.
 *
 * The in-page script treats the children of a reply element as its blocks, give or take rows of the panel's own that
 * carry none. The stand-in panel the page tests run on is built to that same assumption, so it can never contradict it:
 * when 2.1.295 started drawing a time line ahead of the blocks of every reply that has text, every check here stayed
 * green while the figures dropped off those replies. This reads the real thing instead - the children the bundle gives
 * the element with the reply test id - and names each one, so a child nobody has looked at fails the run rather than
 * reaching a panel unnoticed.
 */

const TESTID = '"data-testid":"assistant-message"';

/* The end of a bracketed stretch of minified code, skipping strings and template literals. Good enough for the few
   hundred characters of one element's props; it returns -1 rather than guess when the brackets do not balance. */
function closing(src, open) {
  const pairs = { '[': ']', '(': ')', '{': '}' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ']' || c === ')' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/* The top-level items of an array literal's body. */
function items(body) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < body.length && body[i] !== c; i++) if (body[i] === '\\') i++;
      continue;
    }
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(body.slice(start, i).trim()); start = i + 1; }
  }
  if (body.slice(start).trim()) out.push(body.slice(start).trim());
  return out;
}

/* The body of the function a minified component name refers to, or ''. */
function bodyOf(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) return '';
  const brace = src.indexOf('{', src.indexOf(')', at));
  const end = brace === -1 ? -1 : closing(src, brace);
  return end === -1 ? '' : src.slice(brace, end + 1);
}

/* Whether a component draws the panel's message stamp, itself or through the component it returns. */
function drawsStamp(src, name, depth = 2) {
  const body = bodyOf(src, name);
  if (body.includes('"data-message-stamp"')) return true;
  if (depth <= 1) return false;
  const inner = /return [\w$]+\(([\w$]+),/.exec(body);
  return !!inner && drawsStamp(src, inner[1], depth - 1);
}

/**
 * Each child of a reply element, named: `blocks` for the reply's own content, `time line` for the panel's message
 * stamp drawn ahead of them, `actions` for the bar of buttons drawn after them, `unknown` for anything else. Returns { error } when the element cannot be found or read.
 */
function replyChildren(src) {
  const at = src.indexOf(TESTID);
  if (at === -1) return { error: `no element with ${TESTID}` };
  const kids = src.indexOf('children:[', at);
  if (kids === -1 || kids - at > 2000) return { error: 'the reply element has no children array near its test id' };
  const open = kids + 'children:'.length;
  const end = closing(src, open);
  if (end === -1) return { error: 'the children array of the reply element does not close' };
  return {
    children: items(src.slice(open + 1, end)).map((code) => {
      if (/^[\w$]+\.content\.map\(/.test(code)) return { kind: 'blocks', code };
      const comp = /^[\w$]+\(([\w$]+),\{message:[\w$]+,context:[\w$]+,placement:"response"/.exec(code);
      if (comp && drawsStamp(src, comp[1])) return { kind: 'time line', code };
      if (/className:[\w$]+\.assistantActions\b/.test(code)) return { kind: 'actions', code };
      return { kind: 'unknown', code };
    }),
  };
}

module.exports = { replyChildren, closing, items };

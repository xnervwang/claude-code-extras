// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The work plan as a native VS Code tree view.
 *
 * Native rather than a webview of our own making, because everything a tree needs - collapsing, icons, keyboard
 * navigation, hover, the platform's own look in either theme - already exists here and would otherwise be rewritten in
 * HTML. The cost is that the data has to arrive as nodes rather than as markup, which is also what makes it checkable.
 *
 * The view owns nothing on disk. It reads (see src/workplan.js) and offers the file for editing, which is what lets the
 * plan be corrected by hand: the file is the single copy both halves look at, so a correction cannot diverge from what
 * the conversation reads back.
 */
const vscode = require('vscode');
const { readPlan, readPlans, countOpen, openFirst } = require('./workplan');

/*
 * Icons say the state, and they are told apart by shape rather than by colour: colour alone disappears for a reader who
 * cannot separate these hues, and the panel is read in both light and dark themes.
 */
const LOOK = {
  discussing: { icon: 'comment-discussion', color: 'charts.yellow', word: 'discussing' },
  todo: { icon: 'circle-large-outline', color: 'charts.blue', word: 'to do' },
  parked: { icon: 'debug-pause', color: 'descriptionForeground', word: 'parked' },
  done: { icon: 'pass-filled', color: 'charts.green', word: 'done' },
  dropped: { icon: 'circle-slash', color: 'descriptionForeground', word: 'dropped' },
};
const OPEN = ['discussing', 'todo', 'parked'];

const p2 = (n) => (n < 10 ? '0' : '') + n;

/*
 * When a row was opened, and for a closed one the range up to when it ended.
 *
 * The shape follows the session list this extension already draws in the panel: month before day, an arrow between the
 * ends of a range, and the year written only when it is not the current one. A second convention for the same kind of
 * value would be read as a different kind of value.
 *
 * Minutes rather than the date alone, because a day's worth of rows all carrying one date says nothing about their
 * order - which is the only reason the time is on the row at all. For the same reason the date is not repeated on the
 * far end of a range that begins and ends on one day; the clock is the part that distinguishes them.
 */
function stamp(opened, closed) {
  if (!opened && !closed) return '';
  const thisYear = new Date().getFullYear();
  const part = (ms, withDate) => {
    const d = new Date(ms);
    const clock = p2(d.getHours()) + ':' + p2(d.getMinutes());
    if (!withDate) return clock;
    const md = p2(d.getMonth() + 1) + '/' + p2(d.getDate());
    return (d.getFullYear() === thisYear ? md : d.getFullYear() + '/' + md) + ' ' + clock;
  };
  if (!closed) return part(opened, true);
  if (!opened) return part(closed, true);
  const sameDay = new Date(opened).toDateString() === new Date(closed).toDateString();
  return part(opened, true) + ' → ' + part(closed, !sameDay);
}

/** Whether anything under here still needs doing, which is what decides if a branch opens by itself. */
function hasOpen(node) {
  if (OPEN.includes(node.state)) return true;
  return (node.children || []).some(hasOpen);
}

function summary(counts) {
  const parts = [];
  for (const state of OPEN) if (counts[state]) parts.push(counts[state] + ' ' + LOOK[state].word);
  const closed = (counts.done || 0) + (counts.dropped || 0);
  if (closed) parts.push(closed + ' closed');
  return parts.join(' · ');
}

class WorkPlanProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.plans = [];
    this.signature = '';
    /* The session id of the conversation in front of the reader, as the Claude Code host itself reports it. Only that
       conversation's plan is shown. Empty means the host has not said - no conversation open yet, or a build this
       extension could not patch - and then every plan is shown, since listing them is honest where picking one is not. */
    this.focus = '';
    /* What went wrong installing the plugin that writes the plans, if anything. It is shown as a row rather than in the
       view's welcome text because the welcome text is fixed in the manifest and cannot carry what a command said - and
       a failure that cannot say what failed leaves the reader nothing to act on. */
    this.problem = null;
  }

  /** What the view is drawing, which is what the badge has to be counted over. */
  shown() {
    return this.plans;
  }

  /* Records which conversation to read and says whether that moved; reading and redrawing is refresh()'s job. Doing both
     here made every caller read the file twice, since each one has to call refresh() anyway for the case where the
     conversation stayed put and its plan changed underneath. */
  setFocus(session) {
    const next = String(session || '');
    if (next === this.focus) return false;
    this.focus = next;
    return true;
  }

  setProblem(problem) {
    const before = JSON.stringify(this.problem || null);
    this.problem = problem || null;
    if (JSON.stringify(this.problem) !== before) this._emitter.fire();
  }

  /*
   * Only announces a change when the content actually differs. Announcing one unconditionally on a timer is what makes
   * a tree fold itself back up while it is being read: the view re-asks for its children, and expansion is remembered
   * per item id rather than per item object.
   */
  refresh() {
    /* One file when the host has named the conversation, the directory only when it has not. Reading the directory in
       either case is what put every conversation on the machine into every window, and it made the work grow with how
       many conversations have ever existed rather than with the one being looked at. */
    const plans = this.focus ? readPlan(this.focus) : readPlans();
    /* The focus is part of the signature because two conversations can hold identical plans - most often two empty ones.
       Comparing only the content would then find no change and leave the previous conversation's tree on screen. */
    const signature = JSON.stringify([this.focus, plans.map((p) => [p.session, p.title, p.error, p.nodes])]);
    if (signature === this.signature) return false;
    this.plans = plans;
    this.signature = signature;
    this._emitter.fire();
    return true;
  }

  /*
   * One conversation is shown as its own nodes; several get a root each. The extra level is pure noise in the common
   * case, and its absence is what makes the first row a task rather than a heading.
   */
  getChildren(element) {
    if (!element) {
      const first = this.problem ? [{ kind: 'problem', key: '!plugin' }] : [];
      const plans = this.shown();
      if (!plans.length) return first;
      if (plans.length === 1) return first.concat(this.rowsFor(plans[0]));
      return first.concat(plans.map((p) => ({ kind: 'root', plan: p, key: p.session })));
    }
    if (element.kind === 'root') return this.rowsFor(element.plan);
    if (element.kind === 'node') {
      return this.rowsOf(element.node.children, element.plan, element.key,
        element.path.concat(element.node.title), element.num);
    }
    return [];
  }

  rowsFor(plan) {
    if (plan.error) return [{ kind: 'error', plan, key: plan.session + '/!' }];
    return this.rowsOf(plan.nodes, plan, plan.session, []);
  }

  /*
   * Each row carries a stable id, which is the only thing the view has to remember which branches were open. The index
   * is part of it because two siblings may legitimately share a title, and an id that repeats collapses both.
   *
   * The path is the titles above this row. A row shows only its own title, so for anything nested it is the one piece
   * of context the row cannot carry itself - which is what makes the dialog worth opening even where there is no
   * description to read.
   */
  rowsOf(nodes, plan, parentKey, path, prefix = '') {
    /* Numbered by where the row sits in the file rather than by where it is drawn. The number is part of the id, the id
       is all the view has to remember which branches were open, and the drawn order changes the moment a row closes - so
       numbering by position on screen would hand a row a new id for having been reordered, and the tree would fold
       itself up as work got done. */
    /* The number shown in front of a row comes from its place in the file, like the id above and for the same reason: it
       is what someone says out loud to point at a row, so it must not change because the row moved on screen or because
       another one closed. Numbering the display order would renumber half the tree every time something got done. */
    const rows = (nodes || []).map((n, i) => ({
      kind: 'node', node: n, plan, path, key: parentKey + '/' + i + ':' + n.title,
      num: (prefix ? prefix + '.' : '') + (i + 1),
    }));
    return openFirst(rows, (r) => r.node.state);
  }

  getTreeItem(element) {
    if (element.kind === 'problem') {
      const item = new vscode.TreeItem('The plugin that writes work plans is not installed');
      item.id = element.key;
      item.description = 'click to try again';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = new vscode.MarkdownString(
        `\`${this.problem.step}\` failed.\n\n${this.problem.said || 'It gave no reason.'}\n\n`
        + 'Until this succeeds nothing writes a work plan, so this view stays empty.');
      item.command = { command: 'claudeCodeExtras.installWorkPlanPlugin', title: 'Try again' };
      return item;
    }
    if (element.kind === 'root') {
      const item = new vscode.TreeItem(element.plan.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = element.plan.error ? 'unreadable' : summary(countOpen(element.plan.nodes));
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.id = element.key;
      item.contextValue = 'cceWorkPlanRoot';
      item.tooltip = element.plan.file;
      item.resourceUri = vscode.Uri.file(element.plan.file);
      return item;
    }
    if (element.kind === 'error') {
      const item = new vscode.TreeItem('This work plan could not be read');
      item.id = element.key;
      item.description = 'click to open the file';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = element.plan.file + '\n\n' + element.plan.error;
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(element.plan.file)] };
      return item;
    }
    const node = element.node;
    const look = LOOK[node.state] || LOOK.todo;
    const kids = node.children || [];
    /* The dot is only in the label; element.num stays bare because children are numbered from it. */
    const item = new vscode.TreeItem(`${element.num}. ${node.title}`, kids.length
      ? (hasOpen(node) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None);
    item.id = element.key;
    const times = stamp(node.opened, node.closed);
    /*
     * The row carries its time and nothing else beside the title.
     *
     * Not the state, because the icon already says it and a row should not say one thing twice. Not the note either: it
     * is the longest part of a row and the least urgent, so it pushes the title out of a narrow view to say something
     * that can wait for the hover or the dialog, where both already show it.
     *
     * A row with no time therefore shows only its title. That is deliberate rather than a gap - making the note appear
     * just for those rows would give two rows that look alike different behaviour, with nothing on either saying why.
     */
    item.description = times;
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    item.contextValue = 'cceWorkPlanNode';
    const head = `**${node.title}**\n\n${look.word}${node.note ? ' — ' + node.note : ''}`
      + (times ? '\n\n' + times : '');
    item.tooltip = new vscode.MarkdownString(node.detail ? head + '\n\n' + node.detail : head);
    /*
     * EVERY row opens, including one with no description to show. Binding this only where there is something to read
     * makes two rows that look alike behave differently, with nothing on either saying which is which - and a click
     * that works occasionally reads as broken rather than as economical. A row with nothing further says so, and still
     * carries its state and its place in the plan, which the row itself cannot show.
     *
     * It deliberately does not open the file - clicking a task and being given a page of JSON is not what the click
     * looks like it will do. The file has a button in the title bar and an entry in the row's context menu.
     */
    item.command = {
      command: 'claudeCodeExtras.showWorkPlanDetail',
      title: 'Show the description',
      arguments: [{
        title: node.title, state: look.word, note: node.note, detail: node.detail,
        path: element.path, children: kids.length, times,
      }],
    };
    return item;
  }
}

module.exports = { WorkPlanProvider, summary, hasOpen, stamp, LOOK, OPEN };

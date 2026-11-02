// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Waiting on you as a native tree beside the work plan; src/waiting.js collects the rows.
 *
 * It shows only what waits on the reader. With nothing waiting it is empty, and the view's welcome text says so in one
 * line.
 *
 * Waits older than a week are put in a closed group of their own at the bottom.
 */
const vscode = require('vscode');
const { ageSince } = require('./workplan-view');

/* Different shapes, as in the work plan, so the kinds can be told apart without colour. */
const ICON = {
  prompt: 'shield',
  question: 'question',
};
const WORD = {
  prompt: 'needs you to answer a prompt',
  question: 'asks in its work plan',
};

class WaitingProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.data = { fresh: [], stale: [], count: 0 };
    this.problem = '';
    this.signature = '';
  }

  /*
   * Takes what src/waiting.js collected, and says whether anything shown changed. The ages are part of the comparison
   * because they change while nothing else does.
   */
  set(data, problem = '', now = Date.now()) {
    this.data = data || { fresh: [], stale: [], count: 0 };
    this.problem = problem || '';
    const ages = [];
    for (const g of this.data.fresh.concat(this.data.stale)) for (const it of g.items) ages.push(ageSince(it.since, now));
    const signature = JSON.stringify([this.problem, this.data.fresh, this.data.stale, ages]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this._emitter.fire();
    return true;
  }

  getChildren(element) {
    if (!element) {
      const rows = this.data.fresh.map((g) => ({ kind: 'conversation', g }));
      if (this.data.stale.length) rows.push({ kind: 'old' });
      if (this.problem) rows.unshift({ kind: 'problem' });
      return rows;
    }
    if (element.kind === 'conversation') return element.g.items.map((it, i) => ({ kind: 'item', g: element.g, it, i }));
    if (element.kind === 'old') return this.data.stale.map((g) => ({ kind: 'conversation', g }));
    return [];
  }

  getTreeItem(element) {
    if (element.kind === 'problem') {
      const item = new vscode.TreeItem('Could not list the running conversations');
      item.id = 'waiting/!problem';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = this.problem;
      return item;
    }
    if (element.kind === 'old') {
      const n = this.data.stale.reduce((sum, g) => sum + g.items.length, 0);
      const item = new vscode.TreeItem(`Waiting over 7 days (${n})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'waiting/!old';
      item.iconPath = new vscode.ThemeIcon('history');
      return item;
    }
    const g = element.g;
    const open = { command: 'claudeCodeWorkPlan.openWaitingConversation', title: 'Go to the conversation',
      arguments: [{ sessionId: g.sessionId, id: g.id, kind: g.kind, cwd: g.cwd, title: g.title }] };
    if (element.kind === 'conversation') {
      const item = new vscode.TreeItem(g.title, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'waiting/' + g.sessionId + (g.stale ? '/old' : '');
      const longest = Math.min(...g.items.map((it) => it.since || Infinity));
      item.description = [String(g.items.length), Number.isFinite(longest) ? ageSince(longest) : '']
        .filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon('comment');
      item.tooltip = g.title + (g.cwd ? '\n\nConversation in ' + g.cwd : '');
      item.command = open;
      return item;
    }
    const it = element.it;
    const item = new vscode.TreeItem(it.text);
    item.id = 'waiting/' + g.sessionId + (g.stale ? '/old' : '') + '/' + element.i + ':' + it.kind + (it.row || '');
    item.description = ageSince(it.since);
    item.iconPath = new vscode.ThemeIcon(ICON[it.kind] || 'circle-outline', new vscode.ThemeColor('charts.orange'));
    /* Plain text rather than markdown: the title and the question are whatever somebody typed. */
    item.tooltip = it.text + '\n\n' + g.title + ' ' + WORD[it.kind] + (it.row ? ` (row ${it.row}: ${it.rowTitle})` : '');
    item.command = open;
    return item;
  }
}

module.exports = { WaitingProvider, ICON };

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/* Simplified Chinese for the Conversations view (src/conversations-text.js has the English and what each entry is for). */
module.exports = {
  view: '对话',
  state: { prompt: '停在权限提示', needs: '要你定', working: '在跑', unread: '已回复未读', idle: '空闲' },
  questions: (n) => `${n} 个问题`,
  open: (n) => `${n} 项未完成`,
  noPlan: '没有工作计划',
  doing: (age) => (age ? `在做 ${age}` : '在做'),
  lastWorked: (age) => (age ? `在做（对话空闲 ${age}）` : '在做（对话空闲）'),
  asked: (age) => (age ? `${age}前问的` : '问过'),
  stopped: (n) => `已不在运行、计划未完成 (${n})`,
  folder: (cwd) => `文件夹：${cwd}`,
  status: (n) => `${n} 个要你定`,
  statusIdle: (n) => `对话 ${n}`,
  statusTip: '查看本工程的对话',
  badge: (n) => `${n} 个问题等你回答`,
  problem: '列不出正在运行的对话',
  answerEmpty: '点左边的一个问题，在这里回答。',
  answerRow: (row, title, ago) => `第 ${row} 行${title ? '：' + title : ''}${ago ? ` · ${ago}前问的` : ''}`,
  answerMore: '这一行的详情',
  answerPlaceholder: '你的回答。Ctrl+Enter 发给那个对话。',
  answerOpen: '去对话',
  answerSend: '发送',
  answerNotRunning: '没在运行。去那个对话里回答。',
  answerState: (kind, time) => ({
    waiting: '正在发送……',
    sent: `${time} 已发出。`,
    nobody: '没发：没有哪个 VS Code 窗口开着这个对话。已复制到剪贴板。',
    draft: '没发：那个对话的输入框里已经有字。已复制到剪贴板。',
    'no-input': '没发：那个对话现在不收消息，可能停在权限提示。已复制到剪贴板。',
    lost: '已交给另一个窗口，但它没有回音。去对话里看看。',
    'no-reply': '没发：显示这个对话的窗口没有回应。重载那个窗口再试。已复制到剪贴板。',
  }[kind] || '没发：没能把它填进那个对话。已复制到剪贴板。'),
  answerMessage: (row, question, answer) => `第 ${row} 行的问题「${question}」，我的回答：\n${answer}`,
};

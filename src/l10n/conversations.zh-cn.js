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
};

// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Interface strings for the Conversations view and its status bar entry, by language. Row titles and questions are shown
 * as the conversation wrote them, and so are a work plan's state names (`doing`, `todo`), which the user and Claude use
 * as they are.
 */
const TEXT = {
  en: {
    view: 'Conversations',
    state: { prompt: 'at a permission prompt', needs: 'needs you', working: 'working', unread: 'replied, not read', idle: 'idle' },
    questions: (n) => (n === 1 ? '1 question' : `${n} questions`),
    open: (n) => `${n} open`,
    noPlan: 'no work plan',
    doing: (age) => (age ? `doing for ${age}` : 'doing'),
    lastWorked: (age) => (age ? `doing (conversation idle ${age})` : 'doing (conversation idle)'),
    asked: (age) => (age ? `asked ${age} ago` : 'asked'),
    stopped: (n) => `Not running, with open rows (${n})`,
    folder: (cwd) => `Folder: ${cwd}`,
    status: (n) => (n === 1 ? '1 to decide' : `${n} to decide`),
    statusIdle: (n) => `Conversations ${n}`,
    statusTip: 'Show the conversations of this workspace',
    badge: (n) => (n === 1 ? '1 question for you' : `${n} questions for you`),
    problem: 'Could not list the running conversations',
    answerEmpty: 'Click a question on the left to answer it here.',
    answerRow: (row, title, ago) => `Row ${row}${title ? ': ' + title : ''}${ago ? ` · asked ${ago} ago` : ''}`,
    answerMore: 'Row details',
    answerPlaceholder: 'Your answer. Ctrl+Enter sends it to the conversation.',
    answerOpen: 'Go to the conversation',
    answerSend: 'Send',
    answerNotRunning: 'Not running. Open the conversation to answer it.',
    answerState: (kind, time) => ({
      waiting: 'Sending...',
      sent: `Sent at ${time}.`,
      nobody: 'Not sent: no VS Code window has this conversation open. Copied to the clipboard.',
      draft: 'Not sent: the conversation\'s input already has text in it. Copied to the clipboard.',
      'no-input': 'Not sent: the conversation is not taking messages, maybe at a permission prompt. Copied to the clipboard.',
      lost: 'Handed to another window, which never confirmed it. Check the conversation.',
      'no-reply': 'Not sent: the window showing this conversation did not respond. Reload that window and try again. Copied to the clipboard.',
    }[kind] || 'Not sent: it could not be typed into the conversation. Copied to the clipboard.'),
    answerMessage: (row, question, answer) => `My answer to row ${row} ("${question}"):\n${answer}`,
  },
  'zh-cn': require('./l10n/conversations.zh-cn'),
};

const LANGUAGES = Object.keys(TEXT);

/** The setting first, then VS Code's display language, then English. */
function language(setting, editor) {
  if (LANGUAGES.includes(setting)) return setting;
  return /^zh(-cn|-hans|-sg)?$/i.test(String(editor || '')) ? 'zh-cn' : 'en';
}

const textFor = (lang) => TEXT[lang] || TEXT.en;

module.exports = { TEXT, LANGUAGES, language, textFor };

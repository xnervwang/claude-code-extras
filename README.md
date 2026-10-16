# Work Plan for Claude Code

This VS Code extension adds a Claude-maintained work plan to Claude Code's chat panel: a tree of unfinished work in its own activity-bar view, put back in front of Claude every turn so work survives long, branching conversations and compaction. It also adds smaller panel features listed in the [Features](#features) table.

Not affiliated with Anthropic. Requires Anthropic's Claude Code extension and VS Code 1.94 or later. It changes files inside the installed Claude Code extension; removing it restores them. 25 settings, 11 commands.

## What it looks like

The work plan on the left, times on every message and reply, the table of contents at the right
edge, and the footer controls. Thinking and tool calls shown, which is the default:

![Chat panel with thinking and tool calls shown](images/tools-expanded.png)

The same conversation with the tool calls folded:

![Chat panel with the tool calls folded](images/tools-folded.png)

## Install

Search for **Work Plan for Claude Code** in the Extensions view, or run
`code --install-extension xnervwang.claude-code-extras`. Anthropic's Claude Code extension installs
as a dependency.

Reload the VS Code window twice after installing. Run
`Work Plan for Claude Code: Show Status` for the patch status. In a Remote SSH window, install on the
remote.

Work Plan for Claude Code edits files inside the installed Claude Code extension. The patch is reverted
by removing it or uninstalling the extension; a Claude Code build it does not recognise is left
alone with a warning.

Verified against Claude Code 2.1.300 and 2.1.301; compatibility with other builds unknown.

## Work plan

### What it is

Each conversation gets a tree of what it still has to do, shown in its own activity-bar view.

Long conversations branch when you raise a new topic before finishing the last one, and compaction summarizes older turns. The plan stays in a file outside the conversation; its open rows are given to Claude every turn, so earlier work stays in front of it. Claude keeps the plan up to date as you talk to it.

### Getting a plan

A conversation has no plan until there is something to track. Claude starts one when you raise work to track or ask it to keep a work plan.

In a longer conversation without a plan, the plugin suggests one to Claude once. The thresholds are in [Settings](#settings).

### Talking about rows

Rows have numbers such as 1, 2 and 2.1. Refer to them in any order; one message can settle several rows:

```text
2.1: not now
3: go ahead
```

A number marks a row's place in the file. Finishing a row leaves a gap; nothing is renumbered. A child row is work that must be finished before its parent can be.

### States

| State | Meaning |
| --- | --- |
| `discussing` | Raised, not agreed yet. |
| `todo` | Agreed, not started. |
| `doing` | Being worked on now. |
| `waiting` | Started but held up by someone or something outside the conversation; its note says what it waits on. |
| `parked` | Left for later, with the reason; still open. |
| `done` | Finished. |
| `dropped` | Decided against, with the reason. |

Work you ask Claude to do now goes straight to `doing`; work Claude suggests on its own starts as `discussing`. Only your agreement makes a row `todo`.

### Cost and scope

- With no plan, nothing about the plan is added to a turn. The plugin's skill description loads in every session at about 110 tokens, by the extension's own estimate.
- With a plan, every turn carries short fixed instructions and up to 40 rows. A finished row can be included when a row under it is still open. The cost grows with the number of rows and the length of their text; the page linked below has a measured example.
- Before an automatic compaction, Claude is asked to bring the rows it is working on up to date. After compaction, it is asked to read the plan file before anything else.
- A plan belongs to one conversation. Sub-agents running inside it are not covered; a detached `claude --bg` session gets one task and is not offered a plan.

### Where the plan lives

Each conversation has one file, named by session ID, under `~/.claude/plugins/data/agent-work-plan-claude-code-extras/`.

Claude writes the file through a small command shipped with the plugin; the view only reads it. To correct a plan by hand, open its file from the view's title-bar button or a row's context menu.

See [How the work plan works](docs/how-the-work-plan-works.md) for the hooks, thresholds and measurements.

## Features

| What it shows | Where it appears |
| --- | --- |
| **Timestamps:** Times from the transcript on every message and reply block, with `start→result` on tool calls; Claude Code's own message times are hidden while these are on. | Messages, reply blocks, tool calls |
| **Reply figures:** `2m10s · ctx 33% · cost $0.42 · opus-5 high` shows turn duration, context-window use, running spend, model and effort. | Each reply |
| **Sub-agent tags and filters:** Tag each sub-agent's messages with its task, such as `#look up tomorrow's weather`, and filter to the main thread or one sub-agent. | Tags on messages; filter in the footer |
| **Conversation navigation:** Find your messages by time and first words or find compaction points; filter, click to scroll, step with arrows or `,` and `.`, or jump to the top or bottom. | Right edge of the panel |
| **Focus view button:** Toggle Claude Code's own Focus view; while it is on and Claude works, the working line shows the latest tool call and elapsed time, such as `Bash running for 2m55s (since 11:11:18)`. Only available with Claude Code builds that have Focus view. | Footer button; working line |
| **Context meter:** Keep the meter visible, outline it when 15% of the window remains, and hover for a breakdown by category, memory files and custom agents. | Panel's context meter |
| **Session dates:** `11d · 09/05→09/16` adds a date span after Claude Code's last-active time. | Session list |
| **Pinned conversations:** Pin a conversation on the session list, with the pin shown on hover and a small pin in front of a pinned one's title, and Claude Code's transcript cleanup (`cleanupPeriodDays`) does not delete it and it is not moved to Archived sessions. Before it would be deleted, its files get a later modification time; the list still shows when it was really last active. | Session list; transcripts on disk |
| **Chimes:** Hear a short synthesized sound when a turn finishes, permission is requested or Claude asks a question; mute it in the footer. Sound plays on the machine showing the panel, including with Remote SSH. | Footer; machine showing the panel |
| **Background sessions:** See this conversation's `claude --bg` sessions as running, waiting for you, done, stopped or failed, with what each waits for and its final result; copy the attach or logs command. | Agents button in the footer and its map |
| **Scheduled prompts:** See timers this conversation set through Claude Code's scheduled tasks, with each schedule, last-fired time and prompt. | Agents button in the footer and its map |
| **Background commands:** See a count such as `1 task` while a background build, test run or `sleep` timer runs, with the list one click away. | Footer |
| **Marks on tabs:** A coloured mark after a Claude Code tab's title, in the colour of the dot on its icon: 🔹 while Claude waits for your permission or answer, 🔸 when the conversation finished and you have not looked at it yet. | Editor tab titles |
| **Session information:** See the session ID, starting directory, transcript location and size; click a value to copy it. | Footer button |

## Settings

Open `Work Plan for Claude Code: Settings` for all 25 settings. Most apply without a reload; installing or upgrading the patch needs a reload.

**To turn off**

| What | How |
| --- | --- |
| Panel additions | Set `claudeCodeWorkPlan.enabled` to off. The patch stays and its scripts keep running. |
| Work plan | Set `claudeCodeWorkPlan.workPlan` to off. The view goes, nothing is added to turns, and writes to plan files are refused. |
| Plugin's skill description too | Run `Work Plan for Claude Code: Stop Loading the Work Plan Plugin`. |
| Pins on the session list | Set `claudeCodeWorkPlan.sessionPins` to off. Pinned conversations are then cleaned up and archived as usual; the pins are kept for turning it on again. |
| Patch and restore Claude Code's files | Run `Work Plan for Claude Code: Remove from Claude Code (restore original files)`, or uninstall. |

**Work plan settings**

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeCodeWorkPlan.workPlanOfferMinTurns` | 3 | Messages you must have sent before a conversation without a plan is offered one. |
| `claudeCodeWorkPlan.workPlanOfferMinToolCalls` | 25 | Tool calls one turn must make before that offer. |
| `claudeCodeWorkPlan.workPlanQuietWhenReplyMatches` | empty | Regular expression tested on the latest reply. A match silences the prompts before and after compaction, for conversations relaying another model's replies word for word. Empty matches nothing. |

Message appearance: `claudeCodeWorkPlan.userMessageColor` and `claudeCodeWorkPlan.userMessageEdge`.

Settings named `claudeCodeExtras.*` by earlier versions are copied to the same names under `claudeCodeWorkPlan.*` the first time this version starts. Ones kept in a remote machine's own settings file are not moved; rename those by hand.

## Commands

**Settings and switches**

| Command | What it does |
| --- | --- |
| `Work Plan for Claude Code: Settings` | Open this extension's settings. |
| `Work Plan for Claude Code: Toggle On/Off` | Toggle the additions. |
| `Work Plan for Claude Code: Turn On` | Show the additions. |
| `Work Plan for Claude Code: Turn Off` | Hide the additions. |

**Work plan**

| Command | What it does |
| --- | --- |
| `Work Plan for Claude Code: Refresh Work Plan` | Refresh the view. |
| `Work Plan for Claude Code: Open the Work Plan File` | Open this conversation's plan file. |
| `Work Plan for Claude Code: Install the Work Plan Plugin for Claude Code` | Register the plugin again. |
| `Work Plan for Claude Code: Stop Loading the Work Plan Plugin` | Remove the plugin from Claude Code's settings. |

**Repair and diagnostics**

| Command | What it does |
| --- | --- |
| `Work Plan for Claude Code: Remove from Claude Code (restore original files)` | Restore Claude Code's files. |
| `Work Plan for Claude Code: Show Status` | Show patch status and what was patched. |
| `Work Plan for Claude Code: Show How Long Opening a Panel Took` | Show recorded panel-opening times. |

## Known limits

- If a Claude Code build renames the CSS classes or code shapes the patch looks for, some panel features may stop working. If they do, an orange exclamation mark appears at the panel's top right.
- Uninstalling tries to copy plans to `~/.claude/agent-work-plan-plans-<timestamp>/` before unregistering the plugin, which deletes its data directory. Uninstalling continues if the copy fails, so keep your own copy of a plan that matters.
- Disabling the extension leaves the patch in place. Run `Work Plan for Claude Code: Remove from Claude Code (restore original files)` first.
- Versions up to 1.0.8 left an entry in VS Code's webview cache every three seconds; after weeks, Claude Code panels in editor tabs could stay blank in every window. Version 1.0.9 clears that cache the first time a panel opens. If panels stay blank after uninstalling 1.0.8 or earlier, quit VS Code and delete the `CacheStorage` folders under `WebStorage` in VS Code's data folder: `~/Library/Application Support/Code` on macOS, `%APPDATA%\Code` on Windows, `~/.config/Code` on Linux.
- A plan file is deleted once its conversation's transcript is gone and the file has not been written for a week. Claude Code removes old transcripts, apart from those of conversations pinned on the session list.
- A pinned conversation that the cleanup would have reached is sorted in the session list by the later time its files were given; the time shown is still when it was really last active. Pins are kept in this extension's own storage, which VS Code deletes when the extension is uninstalled.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, checks, and verified-build records.

## License

BSD 3-Clause.

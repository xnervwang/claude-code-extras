# Claude Code Extras for VS Code

Adds navigation, timestamps, reply figures, sounds, and a work-plan view to Anthropic's official Claude Code chat panel. Requires the official extension; no additions without it.
Not affiliated with Anthropic. Requires VS Code 1.94 or later. Version 1.0.0: 23 settings, 11 commands.

## Install

Search for **Claude Code Extras** in the Extensions view, or run
`code --install-extension xnerv.claude-code-extras`. Anthropic's Claude Code extension installs
as a dependency.

Reload the VS Code window twice after installing. Run
`Claude Code Extras: Show Status` for the patch status. In a Remote SSH window, install on the
remote.

Claude Code Extras edits files inside the installed Claude Code extension. The patch is reverted
by removing it or uninstalling the extension; a Claude Code build it does not recognise is left
alone with a warning.

Verified against Claude Code 2.1.285 and 2.1.286; compatibility with other builds unknown.

## Features

| What it shows | Where it appears |
| --- | --- |
| **Timestamps:** transcript times; `start→result` for tool calls; clock today; day and month for older entries; original times in reopened history | Messages, reply blocks, tool calls |
| **Reply figures:** `2m10s · ctx 33% · cost $0.42 · opus-5 high`; turn duration, context-window use, running spend, model | Each reply, including closed turns |
| **Sub-agent tags and filters:** spawn descriptions, such as `#look up tomorrow's weather`; `All`, `Main`, and individual sub-agent filters; table of contents follows filter | Tags on rows; filters in footer |
| **Conversation navigation:** message times, opening words, compaction points; filter box; click-to-scroll; message stepping with arrows, `,`, and `.`; top and bottom jumps | Right-edge table of contents; buttons |
| **Context meter:** visible even with over half the window free; outline at 15% remaining; category, memory-file, and custom-agent breakdown | Chat panel meter; hover tooltip |
| **Session dates:** `11d · 09/05→09/16`; Claude Code relative last-active time, followed by date span | Sessions |
| **Chimes:** two rising notes, three knocks, two falling notes; synthesized sound; no shipped audio files; footer mute button | Finished turn, permission request, question; local panel, including Remote SSH; footer |
| **Work plan:** numbered rows, open rows first; badge counts open rows; discussing, to do, doing, parked, done, dropped; one plan file per conversation; companion plugin installed on first activation; plan files at `~/.claude/plugins/data/agent-work-plan-claude-code-extras/`; extension reads plans, does not write them | Activity-bar tree and work-plan rows; Claude Code plugin; plan-file directory |
| **Session information:** session ID, starting directory, transcript location and size; click-to-copy values | Footer button and session information |

## Settings

Open `Claude Code Extras: Settings` for the settings UI. Options cover message times, reply
figures, sub-agent tags, navigation, footer controls, sounds, session details, the work plan
and its offer thresholds, and panel-opening latency recording. Message appearance:
`claudeCodeExtras.userMessageColor` and `claudeCodeExtras.userMessageEdge`.

Most settings apply live without a reload; installing or upgrading the patch requires a reload.
`claudeCodeExtras.enabled` is the same setting as the **Extras: On/Off** status bar item.
Turning it off hides the additions without restoring the original files.

Turning off `claudeCodeExtras.workPlan` hides the view and stops plan updates. The registered
plugin's skill description still loads in Claude Code; use
`Claude Code Extras: Stop Loading the Work Plan Plugin` to stop loading it.

## Commands

| Command | What it does |
| --- | --- |
| `Claude Code Extras: Settings` | Open this extension's VS Code settings |
| `Claude Code Extras: Toggle On/Off` | Toggle additions |
| `Claude Code Extras: Turn On` | Show additions |
| `Claude Code Extras: Turn Off` | Hide additions |
| `Claude Code Extras: Remove from Claude Code (restore original files)` | Restore original files |
| `Claude Code Extras: Show Status` | Report patch status and what was patched |
| `Claude Code Extras: Refresh Work Plan` | Refresh work plan |
| `Claude Code Extras: Open the Work Plan File` | Open current plan file |
| `Claude Code Extras: Install the Work Plan Plugin for Claude Code` | Register companion plugin |
| `Claude Code Extras: Show How Long Opening a Panel Took` | Read recorded panel-opening times |
| `Claude Code Extras: Stop Loading the Work Plan Plugin` | Remove plugin from Claude Code settings |

## Known limits

- Patched code shapes with renamed CSS classes: panel features may fail; orange exclamation
  mark at the panel's top right.
- Uninstallation unregisters the plugin: Claude Code deletes its data directory; plans copied
  beforehand to `~/.claude/agent-work-plan-plans-<timestamp>/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, checks, and verified-build records.

## License

BSD 3-Clause.

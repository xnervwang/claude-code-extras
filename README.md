# Claude Code Extras for VS Code

Claude Code Extras adds navigation, timestamps, reply figures, sounds, and a work-plan view to the chat panel in Anthropic's official Claude Code extension. The official extension must be installed; Claude Code Extras does nothing without it.

This project is not affiliated with Anthropic. It requires VS Code 1.94 or later. Version 1.0.0 has 23 settings and 11 commands.

## Install

Search for **Claude Code Extras** in the Extensions view, or run `code --install-extension xnerv.claude-code-extras`. Anthropic's Claude Code extension comes with it as a dependency; Claude Code Extras adds to that panel and does nothing without it.

Reload the VS Code window twice. The first reload lets Claude Code Extras write its changes into the Claude Code files. The second lets the panel load them. Run **Claude Code Extras: Show Status** to see what it patched.

In a Remote SSH window, install Claude Code Extras on the remote. The files it edits are the ones the remote runs.

To undo the changes, run **Claude Code Extras: Remove from Claude Code (restore original files)** or uninstall Claude Code Extras. Both restore the originals from backups kept beside them.

## What it adds

- **Timestamps:** Your messages, each reply block, and tool calls show times from the transcript. Tool calls show `start→result`. Today's entries show the clock; older entries also show the day and month. Reopened history retains its original times.
- **Reply figures:** Each reply shows a line such as `2m10s · ctx 33% · cost $0.42 · opus-5 high`: turn duration, context-window use, running spend, and model. Closed turns retain their figures.
- **Sub-agent tags and filters:** Rows show tags from sub-agent spawn descriptions, such as `#look up tomorrow's weather`. A footer filter switches between `All`, `Main`, and individual sub-agents. The table of contents follows the filter.
- **Conversation navigation:** A table of contents on the right edge lists your messages by time and opening words. It has a filter box, marks compaction points, and scrolls to a message when clicked. Arrow buttons and the `,` and `.` keys step between messages. Buttons jump to the top or bottom.
- **Context meter:** The meter stays visible, including when more than half the window is free. An outline warns at 15% remaining. Hover over it for a breakdown by category, memory file, and custom agent in the panel's tooltip.
- **Session dates:** `11d` is Claude Code's own relative time for how long ago the session was last active; Claude Code Extras appends the date span, for example `11d · 09/05→09/16`.
- **Chimes:** Different synthesized sounds mark a finished turn, a permission request, and a question: two rising notes, three knocks, and two falling notes. They play in the panel on your machine, including when VS Code is attached to a remote host over SSH. A footer button mutes them. No audio files ship.
- **Work plan:** An activity-bar tree shows what the current conversation still has to do. Rows are numbered, open rows come first, and the badge counts open rows. The six states are discussing, to do, doing, parked, done, and dropped. A companion Claude Code plugin, installed on first activation, writes one plan file per conversation under `~/.claude/plugins/data/agent-work-plan-claude-code-extras/`. The extension reads those files; it does not write the plans.
- **Session information:** A footer button shows the session ID, the conversation's starting directory, and the location and size of its transcripts. Click a value to copy it.

## How the patch works

Claude Code Extras edits three files inside the installed Claude Code extension: `webview/index.js`, which is the panel; `extension.js`, its host-side Node bundle; and `resources/claude-logo-done.svg`, its done icon.

Each edit matches a code shape rather than an identifier, because identifiers in the minified bundle change between builds. An edit must match exactly once. The patched file must parse before it is written. The original is backed up beside the file, and the replacement is atomic. If a build's shape no longer matches, Claude Code Extras warns and leaves the file unchanged rather than patching on a guess. Removing or uninstalling Claude Code Extras restores the originals from those backups.

Claude Code Extras has been verified against Claude Code **2.1.285** and **2.1.286**. Compatibility with other builds is unknown. `supported-versions.json` records which builds were verified against each commit's own code. A scheduled job checks the newest published Claude Code build four times a day and opens an issue if an edit stops matching. The 181 automated checks parse the injected script and run every edit against an unpatched Claude Code bundle.

## Commands and settings

Open the Command Palette to run these commands:

- `Claude Code Extras: Settings` — open VS Code settings filtered to this extension.
- `Claude Code Extras: Toggle On/Off` — switch the additions on or off.
- `Claude Code Extras: Turn On` — show the additions.
- `Claude Code Extras: Turn Off` — hide the additions.
- `Claude Code Extras: Remove from Claude Code (restore original files)` — restore the original Claude Code files.
- `Claude Code Extras: Show Status` — check the patch status.
- `Claude Code Extras: Refresh Work Plan` — refresh the work plan.
- `Claude Code Extras: Open the Work Plan File` — open the current plan file.
- `Claude Code Extras: Install the Work Plan Plugin for Claude Code` — register the companion plugin.
- `Claude Code Extras: Show How Long Opening a Panel Took` — read recorded panel-opening times.
- `Claude Code Extras: Stop Loading the Work Plan Plugin` — remove the plugin from Claude Code's settings.

Settings let you choose which additions appear: message times and reply figures, sub-agent tags, navigation and footer controls, sounds, and session details. You can also change how your own messages look with `claudeCodeExtras.userMessageColor` and `claudeCodeExtras.userMessageEdge`. The work plan, its offer thresholds, and panel-opening latency recording have their own settings. Use **Claude Code Extras: Settings** to see all options.

Most settings apply live, without a reload. Installing or upgrading the patch itself needs a reload. `claudeCodeExtras.enabled` is also the **Extras: On/Off** status bar setting. Turning it off hides the additions but leaves the patch in place. To restore the original files, use **Claude Code Extras: Remove from Claude Code (restore original files)**.

Turning off `claudeCodeExtras.workPlan` hides the plan view and stops plan updates, but the registered plugin's skill description still loads in Claude Code. Use **Claude Code Extras: Stop Loading the Work Plan Plugin** to stop that too.

## Known limits

A Claude Code update may preserve every patched code shape but rename CSS classes used by the in-page script. In that case, the patch can apply without its panel features working. The script detects this and displays an orange exclamation mark in the panel's top-right corner.

Uninstalling Claude Code Extras unregisters its companion plugin. Claude Code deletes a plugin's data directory when it is unregistered. Before that happens, the plans are copied to `~/.claude/agent-work-plan-plans-<timestamp>/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, how to run the checks, and how the record of verified Claude Code builds works.

## License

BSD 3-Clause.

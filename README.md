# Claude Code Extras for VS Code

Adds to the Claude Code chat panel the things it already knows but does not show: when each message happened, how long
a reply took, how much of the context window is gone, what it cost, which sub-agent said what — plus a way to look at
one agent at a time, a table of contents of your own messages, and a chime when a turn ends.

Nearly all of it appears inside the Claude Code panel rather than in an interface of its own. The one exception is the
work plan, which is a view this extension owns, for the reason given where it is described below.

Not affiliated with Anthropic. It works by editing files inside the installed Claude Code extension, which is why
[How it works, and why it is safe to remove](#how-it-works-and-why-it-is-safe-to-remove) is worth reading before you
install it.

## Installing

You need VS Code and the Claude Code extension already installed; this one adds to that panel and does nothing without
it. There is no published package — build it from this repository, which needs `node` and nothing else. No npm install,
no bundler:

```bash
git clone git@github.com:xnervwang/claude-code-extras-for-vscode.git
cd claude-code-extras-for-vscode
node test/check.js                 # confirms every edit still matches the Claude Code build you have
bash build/pack.sh                 # writes build/xnerv.claude-code-extras-<version>.vsix
code --install-extension build/xnerv.claude-code-extras-*.vsix --force
```

Then reload the window twice: the first reload lets this extension write its changes into the Claude Code files, the
second lets the panel load them. `Claude Code Extras: Show Status` reports what it managed to patch.

Working over SSH in a remote window installs it on the remote, which is where it has to be — the files it edits are the
ones the remote is running.

To undo everything, run `Claude Code Extras: Remove from Claude Code (restore original files)`, or just uninstall the
extension; both put the originals back from the backups it keeps beside them.

## What it adds

**Times.** A timestamp in front of your messages, in front of every block of a reply, and on tool calls as
`start→result`. Today's entries show the clock only; anything older carries the day and month. The times are the real
ones from the transcript, so reopened history reads correctly instead of "now". A row whose real time cannot be read
shows nothing rather than a guess.

**One line of figures per reply.** Something like `2m10s · ctx 33% · cost $0.42 · opus-5 high`: how long that turn
took from your message to the reply, the share of the context window in use at the time, the running spend, and the
model that actually served it. Older replies keep the figures they showed when the turn closed; only the newest reply
keeps updating.

**Sub-agent tags.** Each row carries the name of the sub-agent that produced it, taken from the spawn description
(`#look up tomorrow's weather`), falling back to the last six characters of its identifier when no description is
available.

**A view filter** in the footer toolbar, to the right of the mode selector: `All`, `Main`, or one sub-agent. Switching
hides everything that does not belong to the chosen side, and the table of contents follows — your own messages in the
main view, that agent's tool calls in an agent view.

**A table of contents** of your own messages, opened by the handle on the right edge and closed by clicking outside
it. Each row shows the time and the opening words; hovering shows more, clicking scrolls there. A filter box sits at
the top, and compaction points appear as labelled rules across the list. The arrows above and below the handle step
between messages, as do the `,` and `.` keys when the caret is not in a text field.

**A context meter that stays put.** Claude Code hides its usage meter while more than half the window is still free;
here it is always visible, and it gains a warning outline once the remaining share drops to 15%. Its artwork has only
three states — half, three quarters, nearly full — because it was never shown below half, so anything under 62.5% used
would otherwise draw the half-full arc on an empty conversation; that arc is trimmed in proportion to the real figure,
giving a continuous reading from empty up to half. The meter still stays hidden until a real context window size has
arrived, since the percentage means nothing without one. Hovering it leaves the
panel's own tooltip to give the summary — repeating that in a bubble of our own only stacked two nearly identical
popups — and appends a line to it saying the breakdown is on its way. Once the command-line side has computed it, our
panel replaces that tooltip with the full breakdown by category, memory file and custom agent. The request is never
polled: it fires 200 ms after the pointer settles, and the answer is reused only while the used-token count is
unchanged and less than 20 seconds old. If it cannot be had, nothing of ours appears and the tooltip says so.

**Dates on the session list.** Each session shows how long it ran and the range of dates it covers, as
`11d · 09/05→09/16`. The year appears only when it is not the current one, and only once per range.

**Three chimes, told apart by shape** rather than by volume, so the ear can name them without looking: a turn
finished (two notes rising), Claude is waiting for permission (three short knocks), Claude has asked something (two
notes falling). Waiting for permission is the one that matters most — nothing moves again until you act, and the panel
gives no sound of its own for it. The states come from the session's own signals: its filtered list of pending
permission requests, its list of dialog requests, and the reported "waiting for input" flag as a fallback.

The tones are synthesised, so no audio files are shipped, and they play **in the page** — which renders on your own
machine — so they are heard there even when the editor is attached to a remote host over SSH. The note button in the
footer toolbar mutes all three, and that choice survives reloads.

**A work plan**, in a view of its own behind the list-and-burst icon in the activity bar: what the conversation you are
in still has to do, as a real tree with a state on every row — under discussion, to do, being done now, parked,
done, dropped — carried by the row's icon rather than written out beside it. Several rows can be under way at once,
since one turn can have work going in more than one place, and which of them it is goes in the row's note. A child is something that has to be finished
before its parent can be, so a digression discovered while doing
something sits under the thing it interrupted and the way back is visible. The activity bar icon carries a count of
what is still open, which is the part that works without anything being opened; it is absent rather than zero when
nothing is waiting.

Each row carries a number - 1, 2, then 2.1 beneath them - so a row can be named in conversation instead of having
its title quoted back. The number is the row's place in the file rather than its place on screen, so finishing
something leaves a gap instead of moving every number after it, and one quoted an hour ago still points where it did.

Beside the title a row carries its time and nothing else: when it was opened, to the minute, and for a closed one the
range up to when it ended — `09/28 21:48 → 23:40`. A day's worth of rows all showing one date says nothing about their
order, which is the only reason a time is on the row at all. The format is the one the session list already uses: month
before day, the year only when it is not the current one, and the date not repeated on the far end of a range that begins
and ends on one day. Everything else a row knows — its note, its place in the tree, how many children it must finish
first, its description — is in the hover and in the dialog it opens, so a long note cannot push the title out of a narrow
view.

The view follows the conversation you are looking at, and there is no guesswork in that: the Claude Code host already
tracks which session is active, and one of the two edits this extension makes to that bundle takes the id where it is
already being written. It is an id rather than a title, so nothing has to be matched. Where the host has said nothing —
before the patch is in, or on a build whose shape did not match — every plan is listed instead, which is honest where
picking one of them would not be. Two conversations side by side follow the focused one, so the tree changes when you
click from one into the other.

The plans are written by a companion Claude Code plugin, `agent-work-plan`, which is carried inside this extension and
installed on first activation — so there is one thing to install rather than two, and nothing is fetched over the
network. It keeps one file per conversation, named by its session id, in the data directory the platform gives it:
`~/.claude/plugins/data/agent-work-plan-claude-code-extras/`. **Nothing on the extension side writes those files** — it
reads them, and reaches the file from the title bar button or a row's context menu, which is how a plan gets corrected
by hand. A file that exists and cannot be parsed says so on its own row rather than showing an empty plan, since an
empty plan and no work left look the same.

This is the only part with an interface of its own, and that is not a preference. A view inside the Claude Code panel
would have to be smuggled in: the panel is a webview owned by Claude Code, with no file system and a policy that
refuses a fetch, so the only way text reaches it is hidden inside a file it already loads — a stylesheet or an image.
Owning the view removes the trick entirely, and the cost is only that it sits beside the conversation rather than
within it.

## How it works, and why it is safe to remove

Claude Code's panel is an ordinary web page (`webview/index.js`) and its host side is an ordinary Node bundle
(`extension.js`), both inside the installed Claude Code extension. This extension edits those two files at rest.
Each of the two targets is handled by its own adapter under `src/`, with its own marker and its own backup, so a
failure on one cannot disturb the other.

Every write follows the same rules:

- Each edit matches a code **shape**, not an identifier, because identifiers in a minified bundle change with every
  build. It must match **exactly once**, or nothing at all is written.
- The result must parse before it is written.
- The untouched original is saved beside the file first, and the replacement is atomic.
- A Claude Code build whose shape no longer matches is reported in a warning and left alone — never patched on a guess.
- Removing or uninstalling this extension puts the originals back. The uninstall hook and the extension entry point
  read the same adapter list from `src/adapters.js`, so a target cannot be wired into one and forgotten in the other.

Turning the marks off and changing the message color do not need a reload: they live in a stylesheet written next to
the panel, which the page reloads when a revision number changes. Only installing or upgrading the patch itself asks
for one reload.

The companion plugin is registered the same way — once, quietly, and only on this machine. On first activation the
plugin is copied into this extension's global storage and registered with two commands against the `claude` binary that
ships inside the Claude Code extension: `plugin marketplace add` and `plugin install`. Global storage rather than the
extension's own folder, because a directory marketplace loads a plugin in place and the extension's folder carries a
version number that changes on every upgrade. The registration is recorded and **never asserted again**, so uninstalling
the plugin by hand stays uninstalled; only the copied files are refreshed, when this extension's version changes. If any
of it fails, the work plan view says which step failed and what it reported, and offers to try again — an install that
runs by itself can fail by itself, and a quietly missing feature reads as a broken one.

A row's description is limited to twelve lines, and the view says so where it cuts. The limit is not about fitting the
dialog: a description is what the next person needs in order to pick the task up, and given room what gets written
instead is the story of how the task got here — every turn adding its own reasoning until the plan is a set of chronicles
nobody reads. So there is deliberately no roomier view to escape into. Whatever was cut stays in the file.

Uninstalling this extension unregisters the plugin too. **Unregistering a plugin makes Claude Code delete its data
directory**, which is where the plans are, so they are copied to `~/.claude/agent-work-plan-plans-<timestamp>/` first,
with a note in that folder saying what they are and how to put them back. Nothing else reads it; it is yours to keep or
delete.

There is one failure this cannot prevent: a Claude Code update can keep every patched shape intact yet still rename
the classes the in-page script looks for. That would leave a patch that applied cleanly and does nothing. So the
script checks itself — when the panel clearly holds transcript messages but neither message selector finds any, an
orange exclamation mark appears in the top right corner with an explanation.

**The session id, the directory the conversation started in, where its transcripts are kept, and their size**, behind an
information button at the left of the footer toolbar. Clicking any of them copies it — the id is what resumes this
conversation elsewhere, and not something to retype.

Three of those are values the panel is handed. The transcript directory is derived, because the panel is never told it:
the host groups every conversation started in one directory together, under a name made by replacing each character of
that directory that is not a letter or a digit with a hyphen. It is worth showing precisely because that substitution
cannot be run in the head and cannot be read back — a dot collapses the same way a slash does, and anything outside
ASCII collapses too, so a path with non-Latin names arrives as a row of hyphens with nothing left to recover it from.

The directory shown is the one the conversation *started* in, which is fixed for its whole life. It is not the working
directory of the moment: commands move that around, and the transcript records wherever each one ran, so a single
conversation's records can name a dozen different directories while every one of them lands in the same place.

## What this extension will not do

Constraints, not preferences. Each one has been paid for once.

**It will not change how the conversation works.** Every addition reads what the panel already has. None of them asks
the user — or the model — to work differently so that a display feature has something to show. A feature whose input
has to be manufactured is not worth having: the cost lands on every turn, the benefit on one panel. Concretely: images
already carried by a message are worth drawing, but nothing here is a reason to read an image that would not have been
read anyway.

**It will not put a node of ours inside one the panel owns.** Read their position, add siblings of our own, set
attributes and inline styles on rows — but nothing goes inside. When the panel's own rendering collides with such a
node it throws, and from then on the page stops processing clicks and keys altogether: a dead stop button and a dead
Escape, with no error visible anywhere the user looks.

**It will not let the sweep cost grow with the conversation.** The sweep runs every 250 ms across every message on the
page, and the panel keeps every loaded message in the DOM. Per-row work is cached per element and keyed weakly, and
rows that can no longer change are handed their marks once and then left alone.

**It will not do anything before the panel has painted.** This script is appended to the panel's own bundle, so it runs
while the panel is still laying itself out — whatever it does there is work the panel must get through before it can
show anything at all. Everything that reads or watches the page therefore waits for the browser to report itself idle,
and no resource this script loads may block painting.

Four things once did not, and together they left every panel blank for a remote round trip on every single open — an
empty conversation as much as a long one, because none of it depended on the conversation:

- the settings stylesheet went in as a plain `<link rel="stylesheet">`, which stops the browser painting until the file
  arrives, and on a remote host that file is a round trip away;
- its address carried the clock, so every load was a new address and no panel could reuse a file it already had;
- the on/off switch was read with `getComputedStyle` four times a second — a synchronous style resolution, which the
  browser blocks on while any stylesheet is in flight;
- the mutation observer and the first sweep both started the moment the script ran.

It was found by removing the extension: opening became instant, including long conversations whose *content* still took
a while to load. **That split — window instant, content slow — is the signature.** It says the cost was in startup, and
that nothing about it scaled with the conversation. Startup now prints one line to the panel's devtools console (script
start, work start, first sweep duration and element count, and the browser's own timing for both files), because a page
script has no file system and the channel from the extension runs one way, so that console is the only place such a
question can be answered from.

**It will not patch a build it does not recognise.** Every edit matches its expected shape exactly once or nothing is
written at all. A partial patch is worse than none, and a patch applied on a guess is worse still.

## Commands and settings

| Command | |
|---|---|
| `Claude Code Extras: Settings` | every setting below, in the editor's own settings editor |
| `Claude Code Extras: Toggle On/Off` | also on the status bar item |
| `Claude Code Extras: Turn On` / `Turn Off` | |
| `Claude Code Extras: Remove from Claude Code` | restores the original files and stops patching |
| `Claude Code Extras: Show Status` | per-install patch state |
| `Claude Code Extras: Refresh Work Plan` | also a button in the work plan view |
| `Claude Code Extras: Open the Work Plan File` | the file behind the view, to correct it by hand |
| `Claude Code Extras: Install the Work Plan Plugin for Claude Code` | retries a registration that failed |
| `Claude Code Extras: Show How Long Opening a Panel Took` | the recorded waits, summarised by version |

| Setting | Default | |
|---|---|---|
| `claudeCodeExtras.enabled` | `true` | live |
| `claudeCodeExtras.showStatusBar` | `true` | |
| `claudeCodeExtras.userMessageColor` | `""` | a CSS color for your own messages, live |
| `claudeCodeExtras.userMessageEdge` | `true` | a bar down the left of your own messages, live |
| `claudeCodeExtras.recordOpenLatency` | `true` | off reads nothing and writes nothing |
| `claudeCodeExtras.latencyThresholdSeconds` | `10` | at or above this a wait is recorded; below it, only counted |
| `claudeCodeExtras.workPlanOfferMinTurns` | `3` | how often you have to have spoken before a conversation with no plan is told it could keep one |
| `claudeCodeExtras.workPlanOfferMinToolCalls` | `25` | and how much that turn has to have cost |
| `claudeCodeExtras.show.*` | `true` | one per addition, listed below |

The last two reach the plugin's hooks through a small file the extension writes for them - `config.json`,
beside the plans - because a hook is its own process and cannot read editor settings. The plugin carries the
same defaults, so it behaves the same way with this extension absent.

Each addition has its own switch, `claudeCodeExtras.show.<name>`, and all of them start on:
`timestamps`, `replyDuration`, `contextShare`, `cost`, `modelName`, `subAgentTags`, `toc`, `contextMeter`, `chime`, `sessionDates`, `footerInfo`, `footerPlainView`, `footerViewFilter`, `footerMute`.
They take effect without a reload, and each stops the work rather than hiding the result - a figure the sweep
still computes for every row on every refresh costs the same whether or not it is drawn. What no switch can stop
is the sweep itself, which still walks the rows for whatever is left on; `claudeCodeExtras.enabled` is what turns
that off.

## Known limits

- **A sub-agent view of an older session is often empty.** Restoring a session evicts early messages from the panel,
  and sub-agent transcripts are cleaned off disk after about three days.
- **Rows the panel builds as bare metadata carry no ownership**, so a few of them still show through in an agent view.
- **The dollar figure is an estimate, not a bill.** Claude Code says as much in the description of its own
  `modelPricing` setting; it prices at list rates by default, which need not match what an account is actually charged.
- **The meter's percentage and the panel's percentage are measured differently.** The meter counts down to
  auto-compaction (window minus reserved output minus 13000), while the detail panel divides by the whole window.
  The two numbers disagree by design.
- **The meter reads nearly empty on a conversation just opened, while the breakdown reads it correctly.** They do not
  share a source. The breakdown is computed on demand by the command-line side, so it is right the moment it is asked
  for. The meter — and the panel's own `N% of context remaining` tooltip, which is `100 −` that same figure — reads a
  counter the panel keeps, fed from exactly one place: a main-thread reply arriving with usage on it. So a sub-agent's
  tokens never move it, the update being skipped for anything that carries a parent tool-use id; and opening or
  resuming a conversation zeroes that counter while the replayed history does not fill it back in, leaving the meter
  claiming an almost empty window until the next live reply lands.

  The way anyone actually meets this is a laptop going to sleep: the editor loses its connection to the remote server,
  the page is reloaded on reconnect, and the counter starts from zero on a conversation that is in fact nearly full. So
  the figure is least trustworthy exactly when it would be most useful — coming back to a long conversation after being
  away, which is also when a careless next message is most likely to be the one that overflows. Measured on one such
  conversation: 820,852 tokens in
  use according to both the transcript and the breakdown, with the tooltip claiming 100% remaining — and the compaction
  boundary, which does legitimately zero the counter, arriving two minutes later, so that reset was not the cause.
  Falling back on the breakdown would not repair it, since the breakdown is only fetched while the pointer rests on the
  meter and someone who never hovers never produces one. A real fix has to read usage off the messages the panel
  already holds, which is the next limit.
- **The context share and the spend drop out of the per-reply line together, and for the same reason.** They are gated
  on two different fields, but only one thing writes either: the message that closes a turn. Everything else on that
  line — the duration, the model, the effort — comes from elsewhere, which is what makes their absence readable: a line
  still showing a model but no `ctx` and no `cost` says those two fields are zero rather than that the session is
  unreadable. Of the three places the panel sets a context window, one is the initial zero and one merely carries
  forward whatever was already there, so once it is zero only a turn-closing message lifts it again. That branch is
  guarded on a reported spend being present, so a build that does not report spend leaves the window size unset too —
  one failure, two missing figures. Measured on a conversation showing neither: 2158 replies on record, none of them
  carrying a reported spend and none of the turn-closing shape the panel looks for, while 21 records of a newer
  cost-reporting shape were present that the panel has no code for at all. The transcript is not the channel the panel
  reads, so that count suggests rather than proves what reached it; the spend being unset is the firmer half, since it
  is taken unconditionally when such a message arrives.
  **It clears itself.** Both figures returned together, unprompted, once a turn-closing message finally arrived — which
  is what a single writer behind a single guard predicts, and it rules out the tempting reading of that transcript
  count, that the command-line side had moved to a shape the panel cannot read. So this is a gap after a panel is
  reopened, not a defect to chase: while it lasts the hover breakdown still reports context truthfully, being a
  different path entirely.
- **Per-turn token deltas are not shown.** The message object carries no usage figures, so that would need another
  edit and a table that has to be pruned; not worth it for the value.

## Working on it

### How the code is laid out

| | |
|---|---|
| `extension.js` | activation, settings, commands, the status bar toggle |
| `src/adapters.js` | the list of patch targets, read by both the entry point and the uninstall hook |
| `src/webview.js` | the panel patch — its edits, the live stylesheet, and assembling the in-page script |
| `src/host.js` | the extension-host patch — one edit |
| `src/page/*.js` | the in-page script, one subject per file, concatenated in file-name order |
| `src/workplan.js` | reads the plan files; the whole contract between the two halves is in its header |
| `src/workplan-view.js` | the work plan tree view |
| `src/plugin-install.js` | registers the companion Claude Code plugin, and unregisters it on uninstall |
| `claude-plugin/` | that plugin: the skill that maintains a plan and the three hooks that keep it honest |
| `test/check.js` | parses everything, and verifies every edit against a pristine bundle |
| `test/against-latest.js` | the same check against whatever the marketplace is shipping |
| `build/pack.sh` | produces the `.vsix`, without npm |

The in-page script is kept as ordinary `.js` files rather than one big string for a reason worth knowing before
touching it: as a template literal every backslash needed doubling, and getting that wrong failed only at runtime —
`/\s+/` evaluated to `/s+/` and replaced the letter *s* in every label it passed through. `src/page/README.md` has the
rules for that folder.


```bash
node test/check.js          # parse everything, including the injected script, and verify every edit still matches once
bash build/pack.sh          # produce build/<publisher>.<name>-<version>.vsix (no npm needed)
```

`test/check.js` covers the two things that break silently. It parses the injected script, which is a string inside
`src/webview.js` and therefore invisible to `node --check` on the file itself; and it runs every edit against a
pristine Claude Code bundle, because a match count can only be trusted on an unpatched file.

### Watching for upstream changes

Claude Code ships often — twice in one day has happened — and a release that reshapes any patched code costs the panel
every addition at once. On a machine that is only noticed *after* the update is installed, because the extension then
refuses to patch a build it does not recognise.

```bash
node test/against-latest.js    # fetch whatever the marketplace is shipping and run every edit against it
```

That takes a couple of seconds, and `.github/workflows/upstream-check.yml` runs it four times a day, files one issue
per build when an edit stops matching, and puts the report in the run summary either way. So the news arrives before
the update does.

Neither catches the other kind of break: the in-page script finds elements by class name and test id, and those can
change while every edit still matches exactly once. That one surfaces at runtime instead, as the marker the script
raises in the panel when it can no longer find a single message.

Two rules when changing the patchers:

- **Nothing to bump for the panel; raise `VERSION` by hand for the other two.** The panel's marker carries a digest of
  the injected script and the bundle edits, so a patched file whose contents no longer match this tree is recognised as
  outdated on its own, and its `VERSION` is read by nobody but a human. The host and icon patches mark themselves with a
  plain number instead — `/* CLAUDE-CODE-EXTRAS-HOST v4 */`, `<!-- CLAUDE-CODE-EXTRAS-LOGO v1 -->` — so changing an edit
  in `src/host.js` or `src/logo.js` without raising it leaves an already-patched file recognised as current and never
  rewritten. That is silent in the worst way: packaging, installing and reloading all report success while the old code
  keeps running, so the symptom is an edit with no effect anywhere and no step that complains. The digest exists because
  this used to be true of the panel as well.
- **Reload twice** to see a change: once for this extension to rewrite the file, once for the panel to load it. The
  activity bar icon is the exception — a reload never refreshes it, the editor has to be restarted, and several reloads
  showing the old drawing once sent an afternoon chasing a design problem that had already been fixed.

And one performance rule that has been broken before: the loop in the injected script that walks up the React fiber
tree runs for every visible row on every refresh, so it must keep its early exit (`!out.message`). Making it search
for more than one thing at a time measured eight to ten times slower. `test/check.js` asserts the early exit is
still there.

## License

BSD 3-Clause. The full text is in [LICENSE](LICENSE), and every source file carries the notice at its top so a file
that travels on its own still says what it is under.

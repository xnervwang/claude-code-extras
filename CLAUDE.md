<!-- WRITING-CONTRACT
applies-when: editing-or-extending-this-file
scope: What to know before changing this extension - the sequence a round of change takes, what fails silently, what is left undone
exclude: What it does, how the code is laid out, how to run the checks (README.md); any one session's progress (session directory)
change: free
-->

# Before working in this repository

**What it does, how the code is laid out, the checks and the upstream watch are all in [README.md](README.md).** This
file holds only what that one does not: the sequence a round of change takes, the places that fail without saying so,
and what is knowingly left undone.

Local path `/local/home/xnerv/claude-code-extras-for-vscode`, remote
`git@github.com:xnervwang/claude-code-extras-for-vscode.git`, default branch `main`. It patches the official Claude Code
extension at runtime and carries a Claude Code plugin of its own in `claude-plugin/`.

## One round of change, in full

```bash
node test/check.js                                            # if this fails, stop here
bash build/pack.sh                                            # writes build/<publisher>.<name>-<version>.vsix
code --install-extension build/xnerv.claude-code-extras-1.0.0.vsix --force
```

**Editing a file and then verifying without installing is the most expensive mistake available here.** When someone
reports that what they see is wrong, the first move is to check the installed copy and when each extension host started
— not to compare the sources in this tree. A correct source file says nothing about what is on screen.

```bash
D=~/.vscode-server/extensions/xnerv.claude-code-extras-1.0.0
stat -c '%y' "$D/<the file>"                                  # when the installed copy was written
ps -eo pid,lstart,args | grep '[e]xtensionHost'               # when each host started
```

**A host older than the install is running the old code.** Extension code is loaded into memory when a host activates,
and replacing the file on disk does not reach a host already running. One machine usually has several windows, which
means several hosts, so every window has to be reloaded.

What it takes for a change to appear differs by what was changed, and this table cost an afternoon to learn:

| Changed | What makes it visible |
|---|---|
| the in-page script, `src/page/*` | reload twice: once for this extension to rewrite the bundle, once for the panel to load it |
| the extension side, `extension.js` and `src/*.js` | reload once |
| anything the live stylesheet can express | applies immediately, no reload |
| **the activity bar icon, `images/workplan.svg`** | **restart the editor.** A window reload never refreshes it |
| the marketplace icon, `images/icon.png` | reinstall, then restart the editor |

## Three places that fail without saying so

**Changing an edit in the host or icon patch means raising `VERSION` by hand.** The three patch targets do not mark
themselves the same way:

```
src/webview.js   MARK = prefix + 'v32-' + first 12 of sha256(injected script + edits)   digest; nothing to do
src/host.js      MARK = /* CLAUDE-CODE-EXTRAS-HOST v4 */                                plain number; raise it
src/logo.js      MARK = <!-- CLAUDE-CODE-EXTRAS-LOGO v1 -->                             plain number; raise it
```

Forget it and `status()` reports an already-patched file as `patched`, so it is never rewritten: packaging, installing
and reloading all report success while the old code keeps running.

**The live stylesheet is one file written by every window.** It sits under the official extension's `webview/`, and each
host's thirty-second timer writes it. So what goes into it must not depend on which window wrote it — `readTasks` sorts
its directories for that reason, and taking the sort out brings back a permanent thirty-second tug of war. The file's
first line records the version that wrote it, and an older build leaves a newer one's file alone.

**A change under `claude-plugin/` is picked up by the digest of that tree, not by this extension's version.** The
version only changes when a release is cut, so a plugin file edited between releases was once staged and never staged
again. `plugin-install.digest` is what decides now.

## Drawing an icon: the only trustworthy method

Do not reason about how much room a shape takes from its bounding box. The burst's ink fills 41% of its own box, and
unevenly — 75% across the middle, 6% at the bottom edge — so a box that overlaps a row usually does not mean the ink
does. Rasterise and measure instead: render to PNG, read the alpha channel, scan each row's band for the leftmost ink.
The three line ends were computed that way rather than chosen.

Size is measured too, not judged: the neighbouring official icon `resources/claude-logo.svg` inks 23.9 by 23.9 of its 24
box, and this one is scaled to match.

Two things tried and not worth trying again: laying the burst over full-length rows, which merges them into a blob and
is worst at 24 pixels; and knocking a background-coloured outline out around a row that crosses it, which tears a seam
through the burst and does nothing at all on the masked file.

## Where things stand

A session's task tree, including the rows that were decided against and should not be reopened:

```
~/.claude/plugins/data/agent-work-plan-claude-code-extras/<session id>.json
```

The skill in `claude-plugin/` maintains that file and the side bar reads it. Open rows are injected into every turn, but
the `dropped` ones exist only in the file — read it once when picking the work up rather than trusting the injection.

Two things known and deliberately left:

- **The panel sweep's cost has never been measured.** A sweep over 60 ms already warns itself into the panel's devtools
  console. If it is ever worth measuring, write the numbers to this extension's own output channel. Do not wire them
  into the injected script — that was done once and crashed on reload, and was reverted — and do not ask anyone to call
  `__cceStats()` from devtools, which lives on the inner iframe and reports itself undefined.
- **The panel sometimes comes up blank and never loads, cause unknown.** Next time it happens, the first step is to open
  a conversation in each position — `Claude Code: Open in New Tab` and `Claude Code: Open in Side Bar` — because whether
  it is position-dependent points at entirely different causes. Do not delete the client's `Service Worker` directory to
  "reset" it: that turns "only the tab is blank" into "the side bar is blank too". The method is in the
  `claude-code-panel-slow-open` skill.

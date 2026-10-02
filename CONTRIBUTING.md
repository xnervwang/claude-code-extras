# Contributing

## Layout

- `extension.js` handles activation, settings, commands, and the status bar toggle.
- `src/adapters.js` lists patch targets for both the entry point and the uninstall hook.
- `src/webview.js` holds the panel edits, live stylesheet, and in-page script assembly.
- `src/host.js` holds the extension-host edit.
- `src/logo.js` holds the done-icon edit.
- `src/page/*.js` holds the in-page script, one subject per file. The files are concatenated in file-name order.
- `src/workplan.js` reads plan files. Its header defines the contract between the two halves.
- `src/workplan-view.js` holds the work plan tree view.
- `src/plugin-install.js` registers the companion Claude Code plugin and unregisters it on uninstall.
- `src/openlatency.js` pairs panel-opening times from the official extension's log.
- `claude-plugin/` holds the companion plugin: the skill that maintains a plan and the hooks that keep it honest.
- `test/check.js` runs 181 checks. It parses everything and checks every edit against an unpatched bundle.
- `test/against-latest.js` checks the same edits against the current marketplace build.
- `build/pack.sh` produces the `.vsix` without npm.
- `build/supported.js`, `build/update-versions.js`, and `supported-versions.json` maintain the record of verified Claude Code builds.

## Working on it

Run `node test/check.js` for the full suite. No npm install or dependencies are needed. Run `bash build/pack.sh` to produce the `.vsix`.

The in-page script stays in ordinary `.js` files rather than one large template literal. In a literal, every backslash needed doubling. A missed backslash failed only at runtime: `/\s+/` became `/s+/` and replaced the letter *s* in every label it passed through.

Reload the window twice to see a code change: once for the extension to rewrite the file, then once for the panel to load it. The activity bar icon needs an editor restart; reloading does not refresh it.

The panel patch needs no manual version bump. Its marker includes a digest of the injected script and edits, so a patched file that differs from this tree is recognised as outdated. The host and icon patches use hand-written numbers instead. If you change an edit in `src/host.js` or `src/logo.js`, raise its number. Otherwise an already-patched file is treated as current: packaging, installation, and reloading can all succeed while the old code keeps running.

Two rules the in-page script keeps, each adopted after the failure it prevents. Never put a node of your own inside one the panel owns - read positions, add siblings, set attributes and inline styles, but nothing goes inside. When the panel's own rendering collided with such a node it threw, and from then on the page stopped handling clicks and keys at all: a dead stop button and a dead Escape, with nothing visible to say why. And never do anything before the panel has painted - the script is appended to the panel's own bundle, so whatever it does there is work the panel must finish before it can show anything. Everything that reads or watches the page waits for the browser to report itself idle.

Keep the early exit in the injected script's React fiber tree loop. It runs for every visible row on every refresh. Searching for more than one thing at a time measured 8–10× slower. `test/check.js` checks that the early exit remains.

## Watching for upstream changes

Claude Code ships roughly once per working weekday. If a release reshapes patched code, the panel can lose every addition at once. On a user's machine, that may become apparent only after the update is installed.

Run `node test/against-latest.js` to fetch the current marketplace build and check every edit against it. `.github/workflows/upstream-check.yml` runs that check four times a day. It files one issue per build when an edit stops matching and puts the report in the run summary either way.

These checks cannot catch changes to class names or test ids used by the in-page script. Every edit can still match exactly once while those lookups break. That failure appears at runtime through a marker the script raises in the panel.

## The record of verified builds

`supported-versions.json` records the Claude Code builds **this commit** was verified to patch. Someone using an older build can use the record to find a commit that works with it.

Record only builds verified against the current code. Leave out a build that is not installed on the machine writing the commit, even if an earlier commit verified it. To find that earlier commit, ask git:

```sh
git log -S2.1.283 -- supported-versions.json
```

Nothing is written unless the full suite passes. `node build/update-versions.js` shows what would change. `node build/update-versions.js -w` runs the suite and then writes the record.

The suite fails if the record differs in either direction from the builds the machine just verified. Listing more makes a false claim. Listing fewer can leave an upgrade unrecorded forever, because a conservative record would not otherwise fail a check.

This check needs the installed bundles, so it cannot run in CI. A runner has no Claude Code installed, and the section reports itself as skipped. Enforcement is local. To enable the pre-commit hook, run:

```sh
git config core.hooksPath build/git-hooks
```

Git does not install repository hooks automatically. The hook runs the same suite; it reports a mismatch and stops rather than writing the record for you.

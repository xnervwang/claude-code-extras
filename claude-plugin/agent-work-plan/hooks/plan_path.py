# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Where this conversation keeps its work plan.

Shared by both hooks rather than written twice: one of them reads the file and the other watches its timestamp, so two
copies of this that drifted apart would leave the nudge watching a path nobody writes - and nothing would say so.
"""
import json
import os
import sys

# The platform gives every plugin a data directory named <plugin>-<marketplace>, and hooks.json passes ours in as
# ${CLAUDE_PLUGIN_DATA}. This is that same name spelled out, for the case where the expansion did not happen. It is
# also the one directory the VS Code extension reads, so falling back to it keeps the two halves looking at one place.
FALLBACK = os.path.join(os.path.expanduser("~"), ".claude", "plugins", "data", "agent-work-plan-claude-code-extras")


def data_dir():
    given = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CLAUDE_PLUGIN_DATA", "")
    # An unexpanded placeholder arrives as its own literal text, which would otherwise become a directory of that name.
    if given and "$" not in given and os.path.isabs(given):
        return given
    return FALLBACK


"""What the VS Code extension writes here for the hooks to read, and what it means when it is absent.

The hooks are separate processes started by Claude Code, so they cannot read editor settings. The extension writes the
few numbers that are worth changing into this one file instead, which keeps the editor's own settings UI as the single
place a person edits them.

Absent is the ordinary case rather than an error: this plugin is meant to work on its own, with or without that
extension, so every value here has a default that holds by itself.
"""
SETTINGS_FILE = "config.json"
DEFAULTS = {
    # Off means this plugin does nothing at all: no rows in front of the model, no reminder at the end of a turn, and a
    # write to the plan refused rather than quietly kept up. Hiding the view alone would be the worst of both - the
    # whole cost still paid every turn, with nothing to show for it.
    "enabled": True,
    # How many things a turn has to have CHANGED before it owes the plan anything. Counting tool calls instead was the
    # first shape of this and it was the wrong measure: reading, grepping and measuring are all tool calls, so a turn
    # spent explaining or investigating tripped the same threshold as a turn that finished three tasks. Measured over one
    # conversation, 29 reminders produced 10 entries and 18 produced nothing, and the densest run of them landed on turns
    # that had changed nothing at all. Meanwhile 14 other conversations kept a plan, wrote to it 269 times between them,
    # and never saw one reminder - what maintains a plan is having it in front of the model every turn, not this.
    "nudgeMinChanges": 2,
    # What a turn has to cost before a conversation with no plan at all is told it could keep one. The upper quartile of
    # turns begins at 25 tool calls, measured over 691 of them.
    "offerMinToolCalls": 25,
    # How many times the user has to have spoken first. A plan is for a conversation that branches, and a session handed
    # one task and left to do it cannot branch - measured over 61 offers, 53 went to single-turn workers and none of
    # them wanted a plan, while every conversation that did want one had spoken at least three times.
    "offerMinTurns": 3,
}


def settings():
    """The numbers above, with anything the extension wrote on top. A bad value is ignored rather than fatal."""
    out = dict(DEFAULTS)
    try:
        with open(os.path.join(data_dir(), SETTINGS_FILE), encoding="utf-8") as fh:
            given = json.load(fh)
    except Exception:
        return out
    for key, fallback in DEFAULTS.items():
        value = given.get(key) if isinstance(given, dict) else None
        # Checked against the default's own type: a number where a flag belongs, or the other way round, is a mistake
        # rather than an instruction, and the default is the safer of the two readings.
        if isinstance(fallback, bool):
            if isinstance(value, bool):
                out[key] = value
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if value >= 1:
            out[key] = int(value)
    return out


def plan_file(payload):
    """This conversation's file, named by its session id - which is unique across every project on a machine.

    So there is no grouping directory and none is derived: the earlier shape reconstructed one from the transcript path,
    where the project part is a starting directory with every character that is not a letter or a digit replaced, and
    that substitution cannot be reversed.
    """
    session = str(payload.get("session_id") or "").strip()
    if not session or os.sep in session or session in (".", ".."):
        return None
    return os.path.join(data_dir(), session + ".json")

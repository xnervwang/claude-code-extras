#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Put this conversation's work plan in front of the model, every turn.

This is the load-bearing half of the plugin, and the reason it is a hook rather than part of the skill: a skill is
loaded when its description matches the request, so it is absent on exactly the turn that wanders off - which is the
only turn where being reminded of the main line matters.

Only the open rows are injected. The closed ones are history; sending them every turn would cost context to say
nothing, and the file itself is there for anyone who wants the whole thing.

Silence is the normal case. A conversation that keeps no plan gets nothing, so installing this plugin costs nothing
until something starts writing one.
"""
import json
import sys

# Set before the import below: importing a module next to this one otherwise leaves compiled bytecode in the installed
# plugin directory, and a hook that runs on every turn should leave nothing behind in a directory the platform manages.
sys.dont_write_bytecode = True

from plan_path import plan_file

STATES_OPEN = ("discussing", "todo", "parked")
GLYPH = {"discussing": "?", "todo": "o", "parked": "=", "done": "+", "dropped": "x"}
# Enough for a plan a person reads; a runaway file must not turn every turn into a wall of text.
MAX_ROWS = 40


def rows(nodes, depth, out, prefix=""):
    """Render the open rows, each numbered by where it sits in the file.

    The number is what a person says to point at a row, so it comes from the file rather than from what is on screen:
    closed rows are skipped when drawing but still counted, or finishing one would renumber everything after it and a
    number quoted yesterday would mean a different row today. The same numbers appear in the tree view, computed the same
    way, because two places disagreeing about which row is 3 would be worse than neither showing a number.
    """
    for i, node in enumerate(nodes or []):
        if len(out) >= MAX_ROWS:
            return
        num = "%s%d" % (prefix + "." if prefix else "", i + 1)
        state = node.get("state", "todo")
        title = str(node.get("title", "")).strip()
        if not title:
            continue
        kids = node.get("children") or []
        # A closed row is kept only while something under it is still open, since that is what says where to return to.
        if state not in STATES_OPEN and not any_open(kids):
            continue
        note = str(node.get("note", "")).strip()
        out.append("%s%s %s %s%s" % ("  " * depth, GLYPH.get(state, "o"), num, title,
                                     "   [%s%s]" % (state, " · " + note if note else "")))
        rows(kids, depth + 1, out, num)


def any_open(nodes):
    for node in nodes or []:
        if node.get("state", "todo") in STATES_OPEN or any_open(node.get("children")):
            return True
    return False


def counts(nodes, acc=None):
    acc = acc if acc is not None else {}
    for node in nodes or []:
        state = node.get("state", "todo")
        acc[state] = acc.get(state, 0) + 1
        counts(node.get("children"), acc)
    return acc


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        # Absent is ordinary; half-written is transient and fixes itself on the next turn. Neither is worth saying.
        return 0
    nodes = plan.get("nodes") or []
    out = []
    rows(nodes, 0, out)
    if not out:
        return 0
    n = counts(nodes)
    head = " · ".join("%d %s" % (n[s], s) for s in STATES_OPEN if n.get(s))
    closed = n.get("done", 0) + n.get("dropped", 0)
    if closed:
        head += " · %d closed" % closed
    text = ("This conversation's work plan (%s). Only open rows are shown; the file is %s.\n"
            "A child is something that has to be finished before its parent can be.\n\n%s"
            % (head or "nothing open", path, "\n".join(out)))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"),
        "additionalContext": text,
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

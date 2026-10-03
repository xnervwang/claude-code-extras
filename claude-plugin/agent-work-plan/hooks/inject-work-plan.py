#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Put this conversation's work plan in front of the model, every turn.

This is the load-bearing half of the plugin, and the reason it is a hook rather than part of the skill: a skill is
loaded when its description matches the request, so it is absent on exactly the turn that wanders off - which is the
only turn where being reminded of the main line matters. Measured over 1324 turns that had a plan put in front of them,
the skill was loaded 12 times. So whatever a model has to know in order to keep the plan right is said here, and the
skill is where it is explained at length.

Only the open rows are injected. The closed ones are history; sending them every turn would cost context to say
nothing, and the file itself is there for anyone who wants the whole thing.

Silence is the normal case. A conversation that keeps no plan gets nothing, so installing this plugin costs nothing
until something starts writing one.

It also leaves a mark beside the plan saying which turn this is and when it began, for the hook that watches the turn
(remind-work-plan.py). That is written before anything here can decide to stay quiet: a plan whose rows are all closed
injects nothing, and new work started in that turn is exactly what the other hook is for.
"""
import json
import os
import shlex
import sys
import time

# Set before the import below: importing a module next to this one otherwise leaves compiled bytecode in the installed
# plugin directory, and a hook that runs on every turn should leave nothing behind in a directory the platform manages.
sys.dont_write_bytecode = True

from plan_path import OPEN_STATES, epoch, plan_file, settings, write_turn

GLYPH = {"discussing": "?", "todo": "o", "doing": ">", "waiting": "~", "parked": "=", "done": "+", "dropped": "x"}
# Enough for a plan a person reads; a runaway file must not turn every turn into a wall of text.
MAX_ROWS = 40
# The two states a row is meant to leave soon, so how long one has been in either is worth saying: a row `doing` for
# three days is not being done, and nothing else on the row shows that. Measured on the machine this was written on, the
# six rows then `doing` included two added four days earlier, and four whose own notes said they were waiting on someone.
TIMED = ("doing", "waiting")
# The command that changes a row, given with its full path every turn so it never has to be found.
ROW_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plan-row.py")


def age(seconds):
    if seconds < 3600:
        return "%dm" % max(1, seconds // 60)
    if seconds < 48 * 3600:
        return "%dh" % (seconds // 3600)
    return "%dd" % (seconds // 86400)


def rows(nodes, depth, out, now, prefix=""):
    """Render the open rows, each numbered by where it sits in the file.

    The number is what a person says to point at a row, so it comes from the file rather than from what is on screen:
    closed rows are skipped when drawing but still counted, or finishing one would renumber everything after it and a
    number quoted yesterday would mean a different row today. The same numbers appear in the tree view, computed the same
    way, because two places disagreeing about which row is 3 would be worse than neither showing a number.
    """
    # Newest first, the same way the tree view draws them, while the number still comes from the real position: rows are
    # only appended, so the end of the file is the current work. Reversing here also means the cap below drops the oldest
    # rows rather than the newest, which is the half worth keeping.
    numbered = [("%s%d" % (prefix + "." if prefix else "", i + 1), node)
                for i, node in enumerate(nodes or [])]
    for num, node in reversed(numbered):
        if len(out) >= MAX_ROWS:
            return
        if not isinstance(node, dict):
            continue
        state = node.get("state", "todo")
        title = str(node.get("title", "")).strip()
        if not title:
            continue
        kids = node.get("children") or []
        # A closed row is kept only while something under it is still open, since that is what says where to return to.
        if state not in OPEN_STATES and not any_open(kids):
            continue
        note = str(node.get("note", "")).strip()
        said = str(state)
        if state in TIMED:
            since = epoch(node.get("since"))
            if since is not None and now >= since:
                said += " for " + age(int(now - since))
        # The dot is only in what is drawn; `num` stays bare because children are numbered from it.
        out.append("%s%s %s. %s%s" % ("  " * depth, GLYPH.get(state, "o"), num, title,
                                      "   [%s%s]" % (said, " · " + note if note else "")))
        rows(kids, depth + 1, out, now, num)


def any_open(nodes):
    return any(isinstance(n, dict) and (n.get("state", "todo") in OPEN_STATES or any_open(n.get("children")))
               for n in nodes or [])


def any_in(nodes, state):
    return any(isinstance(n, dict) and (n.get("state") == state or any_in(n.get("children"), state))
               for n in nodes or [])


def counts(nodes, acc=None):
    acc = acc if acc is not None else {}
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        state = node.get("state", "todo")
        acc[state] = acc.get(state, 0) + 1
        counts(node.get("children"), acc)
    return acc


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict) or not settings()["enabled"]:
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
    if not isinstance(plan, dict):
        return 0
    now = time.time()
    prompt = payload.get("prompt_id")
    if isinstance(prompt, str) and prompt:
        write_turn(path, {"prompt": prompt, "began": now, "changes": 0, "reminded": False})
    nodes = plan.get("nodes") or []
    out = []
    rows(nodes, 0, out, now)
    if not out:
        return 0
    n = counts(nodes)
    head = " · ".join("%d %s" % (n[s], s) for s in OPEN_STATES if n.get(s))
    closed = n.get("done", 0) + n.get("dropped", 0)
    if closed:
        head += " · %d closed" % closed
    command = "python3 %s %s" % (shlex.quote(ROW_TOOL), shlex.quote(path))
    # What is said about `doing` is here rather than only in the skill because here is the one moment that comes BEFORE
    # the work, and the skill is rarely loaded at all. A row marked as the work starts shows up in the tree while the
    # turn runs, which is the whole point of the state.
    #
    # The line after it changes with the plan rather than being the same every turn: a sentence repeated word for word
    # on every turn is the one most easily read past, and "nothing is doing" is a fact about this turn that the model can
    # check against what it is about to do.
    text = "\n".join([
        "This conversation's work plan (%s). Only open rows are shown; the file is %s." % (head or "nothing open", path),
        "A child is something that has to be finished before its parent can be.",
        "Set a row to `doing` as you start on it, not afterwards. Work the user asks for in this message goes in as "
        "`doing` as soon as you start on it, and so does a request to look into something. When you stop working on a "
        "row, move it on: `done` if it is finished, `waiting` if it now waits on someone else, with what it waits on in "
        "its note.",
        ("A row that is `doing` now was left that way by an earlier turn: unless this turn carries on with it, or an "
         "agent you started is still working on it, move it on." if any_in(nodes, "doing")
         else "Nothing is `doing` right now."),
        "To change a row: %s set <row> <state> [--note TEXT]. To add one: %s add <state> TITLE [--under <row>]. Both "
        "read the clock themselves." % (command, command),
        "",
    ] + out)
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "UserPromptSubmit"),
        "additionalContext": text,
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

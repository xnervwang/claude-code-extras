#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Say so, once, when a turn starts working and no row of the work plan is `doing`.

The injection asks for `doing` at the start of every turn, and that was not enough. Measured over the conversations on
the machine this was written on, 177 turns began with nothing marked `doing` and went on to edit a file or commit; 55 of
them went to the plan first. 110 first wrote to the plan only after the work had started - at the median on the turn's very
last tool call, and 95 of those writes did not mention `doing` at all - so for a median of 327 seconds the tree beside
the conversation showed nothing being worked on, which is the one thing the state is for. Those turns kept the plan as
bookkeeping done before the closing summary, which is how every other instruction about it reads.

So this speaks at the moment the work starts rather than at either end of the turn. The turn's own tool calls are what
say it has started, and this runs after each batch of them. Every call counts, reading included: the injection counts
looking into something as work to mark, so a turn that only reads and searches needs a `doing` row as much as one that
edits. Changes - judged the way the end-of-turn reminder judges them (changes.py) - are counted as well, so that two in a
turn's first batch are enough without waiting for a third call.

It speaks only when all of these hold:
  - this is the main thread. A sub-agent shares the session id, and its work is recorded by the thread that sent it;
  - the turn has made at least remindMinCalls calls or changed at least nudgeMinChanges things, not counting the
    plan's own;
  - no row is `doing`;
  - it has not already spoken in this turn.

Having written to the plan does not excuse a turn. Closing the previous row and then starting on the next is a write,
and it leaves the tree showing nothing being worked on - the state this exists for. Only a row that is `doing` settles
the turn.

What it does not do is refuse the call, or work out which row is being worked on. The first would change how a
conversation runs, which this plugin does not do; the second is a judgement about what the work is, which a script
cannot make. So it can only ask, and it asks once: a reminder that repeats when it has been read and set aside is one
that teaches the reader to skip it.

The turn's facts - when it began, how much it has done - come from the mark the injection hook leaves when the turn
begins (see plan_path.py). Without that mark there is nothing to go on, and this stays silent.
"""
import json
import os
import shlex
import sys

# Set before the import below: see inject-work-plan.py. A hook that runs after every batch of tool calls leaves no
# bytecode behind in the installed plugin directory.
sys.dont_write_bytecode = True

from changes import changes
from plan_path import plan_file, read_turn, settings, write_turn

ROW_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plan-row.py")


def any_doing(nodes):
    return any(isinstance(n, dict) and (n.get("state") == "doing" or any_doing(n.get("children")))
               for n in nodes or [])


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict) or payload.get("agent_id"):
        return 0
    calls = payload.get("tool_calls")
    if not isinstance(calls, list) or not calls:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    name = os.path.basename(path)
    # A call that names the plan is the plan being kept, not the work it describes.
    work = [c for c in calls if isinstance(c, dict)
            and name not in json.dumps(c.get("tool_input"), ensure_ascii=False, default=str)]
    if not work:
        return 0
    prompt = payload.get("prompt_id")
    if not isinstance(prompt, str) or not prompt:
        return 0
    turn = read_turn(path)
    if not turn or turn.get("prompt") != prompt or turn.get("reminded") or turn.get("settled"):
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    turn["calls"] = count(turn.get("calls")) + len(work)
    turn["changes"] = count(turn.get("changes")) + sum(
        1 for c in work if changes(c.get("tool_name"), c.get("tool_input")))
    if turn["calls"] < limits["remindMinCalls"] and turn["changes"] < limits["nudgeMinChanges"]:
        write_turn(path, turn)
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except Exception:
        return 0
    if not isinstance(plan, dict):
        return 0
    if any_doing(plan.get("nodes")):
        turn["settled"] = True
        write_turn(path, turn)
        return 0
    turn["reminded"] = True
    # A mark that cannot be written would make this speak after every batch for the rest of the turn, which is the
    # one outcome worth avoiding; silence is the safe side.
    if not write_turn(path, turn):
        return 0
    command = "python3 %s %s" % (shlex.quote(ROW_TOOL), shlex.quote(path))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "PostToolBatch"),
        "additionalContext": (
            "This turn has started working, and no row of the work plan is `doing`. Mark the one you are working on "
            "before going on - or, if this is new work the user asked for or something they asked you to look into, "
            "add it as `doing`:\n"
            "  %s set <row> doing\n"
            "  %s add doing TITLE [--under <row>]\n"
            "The tree beside this conversation shows `doing` while the work runs, which is the only time it is any "
            "use. This is said once per turn." % (command, command)),
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

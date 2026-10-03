#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Say so, once, when a turn starts changing things and no row of the work plan is `doing`.

The injection asks for `doing` at the start of every turn, and that was not enough. Measured over the conversations on
the machine this was written on, 177 turns began with nothing marked `doing` and went on to edit a file or commit; 55 of
them went to the plan first. 110 first wrote to the plan only after the work had started - at the median on the turn's very
last tool call, and 95 of those writes did not mention `doing` at all - so for a median of 327 seconds the tree beside
the conversation showed nothing being worked on, which is the one thing the state is for. Those turns kept the plan as
bookkeeping done before the closing summary, which is how every other instruction about it reads.

So this speaks at the moment the work starts rather than at either end of the turn. The turn's own tool calls are what
say it has started, and this runs after each batch of them; a batch counts when it changes something, judged the way the
end-of-turn reminder judges it (changes.py). Measured over the same turns, the first such change comes after two other
tool calls at the median and after seven at the ninetieth percentile, so waiting for it costs little of the turn - and a
turn that never changes anything rarely runs past two calls.

It speaks only when all of these hold:
  - this is the main thread. A sub-agent shares the session id, and its work is recorded by the thread that sent it;
  - the turn has changed at least nudgeMinChanges things, not counting the plan itself;
  - the plan has not been written since the turn began. A turn that has already been to the plan has settled it, and
    this is for the turns that start working without going there at all;
  - no row is `doing`;
  - it has not already spoken in this turn.

What it does not do is refuse the call, or work out which row is being worked on. The first would change how a
conversation runs, which this plugin does not do; the second is a judgement about what the work is, which a script
cannot make. So it can only ask, and it asks once: a reminder that repeats when it has been read and set aside is one
that teaches the reader to skip it.

The turn's facts - when it began, how much it has changed - come from the mark the injection hook leaves when the turn
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
    changed = sum(1 for c in calls
                  if isinstance(c, dict) and changes(c.get("tool_name"), c.get("tool_input"))
                  and name not in json.dumps(c.get("tool_input"), ensure_ascii=False, default=str))
    if not changed:
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
    so_far = turn.get("changes")
    turn["changes"] = (so_far if isinstance(so_far, int) and not isinstance(so_far, bool) else 0) + changed
    began = turn.get("began")
    try:
        touched = os.stat(path).st_mtime
    except Exception:
        return 0
    if not isinstance(began, (int, float)) or touched >= began:
        turn["settled"] = True
        write_turn(path, turn)
        return 0
    if turn["changes"] < limits["nudgeMinChanges"]:
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
            "This turn has started changing things, and no row of the work plan is `doing`. Mark the one you are "
            "working on before going on - or, if this is new work the user asked for, add it as `doing`:\n"
            "  %s set <row> doing\n"
            "  %s add doing TITLE [--under <row>]\n"
            "The tree beside this conversation shows `doing` while the work runs, which is the only time it is any "
            "use. This is said once per turn." % (command, command)),
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

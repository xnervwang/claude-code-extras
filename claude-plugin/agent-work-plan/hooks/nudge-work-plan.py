#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Say something when a turn did real work and left the work plan untouched.

The skill says when to update the plan. This exists because a rule about noticing a state change is the kind that fails
in the moment it is needed - the same reason the injection hook exists rather than trusting the skill to be loaded.

It is deliberately hard to trigger. A reminder that fires when nothing was owed teaches the reader to skip it, and a
skipped reminder is worse than none: it costs attention on every turn and buys nothing on the turn that matters. So it
speaks only when the turn changed something, the plan is older than the turn, AND the turn never went to the plan at
all.

That last condition is what lets the reminder be answered. Reading the plan and finding nothing owed is a complete
reconciliation, but it leaves no mark on the file - so judging by the file's age alone, a turn that had looked and a
turn that had forgotten were the same turn. The reminder then repeated on every working turn for the rest of a
conversation whose plan was already correct, and each repeat cost a round of explaining that nothing was owed. Three in
a row is what prompted this.

Where no plan exists at all it speaks once, and then never again in that conversation. This is the harder case, because
until something writes a plan the injection hook has nothing to inject and the skill is only found when its description
happens to match - so a conversation can run to its end without the facility ever being mentioned. Measured across 1835
transcripts on the machine this was written on, 4 of them had a plan. A hook staying quiet to cost nothing is how that
happens, so the cost is now one sentence, once, after a turn big enough to have needed it.
"""
import json
import os
import sys

# Set before the import below: see inject-work-plan.py. A hook that runs on every turn leaves no bytecode behind in the
# installed plugin directory.
sys.dont_write_bytecode = True

from plan_path import plan_file, settings

# Every threshold this uses is in plan_path.DEFAULTS, where the editor's settings can override it.


def spoke(row):
    """True when this row is the user actually saying something, rather than a tool handing a result back.

    Both are recorded as `user`, which is why this is asked in two places and not inlined at either.
    """
    if row.get("type") != "user":
        return False
    content = (row.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in content)
    return False


def turn_shape(transcript, plan=""):
    """When this turn began, how many tools it used, how many times the user has spoken, and whether it went to the plan.

    The turn begins at the last message the user sent, so the transcript is walked from the end and stops there. Reading
    it whole would mean parsing megabytes on every turn, so only the tail is read.

    That tail is also where the count of turns comes from, and it is a lower bound rather than a total: a conversation
    long enough to overflow the window has more turns than are visible here. The bound is in the safe direction - it can
    only make this quieter, and being too quiet costs a reminder while being too loud costs every reminder's credibility.

    Going to the plan is looked for ONLY in the calls the assistant made, never anywhere else in the turn. The path is
    also in the text this plugin injects at the start of every turn, so a search across whole rows would find it every
    time and the reminder would never be able to fire at all.
    """
    try:
        with open(transcript, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            window = min(size, 2 * 1024 * 1024)
            fh.seek(size - window)
            lines = fh.read().decode("utf-8", "replace").split("\n")
    except Exception:
        return None, 0, 0, False
    rows = []
    for line in lines:
        if '"type"' not in line:
            continue
        try:
            rows.append((json.loads(line), '"tool_use"' in line, line))
        except Exception:
            continue
    started, tools, reached = None, 0, False
    for row, used_tool, line in reversed(rows):
        if spoke(row):
            started = row.get("timestamp")
            break
        if used_tool:
            tools += 1
            if plan and plan in line:
                reached = True
    return started, tools, sum(1 for row, _, _ in rows if spoke(row)), reached


def iso_to_epoch(stamp):
    try:
        import datetime
        return datetime.datetime.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=datetime.timezone.utc).timestamp()
    except Exception:
        return None


def speak(payload, text):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "Stop"),
        "additionalContext": text,
    }}))
    return 0


def offer_once(payload, path, tools, turns, limits):
    """Tell a conversation that has no plan that it could keep one, at most one time.

    Having offered is remembered as an empty file beside where the plan would go: this is a new process on every turn
    and has nowhere else to put it. If the marker cannot be written the offer is not made at all - saying it on every
    turn instead is the one outcome worth avoiding, and a directory that refuses the marker would refuse the plan too.
    """
    if tools < limits["offerMinToolCalls"] or turns < limits["offerMinTurns"]:
        return 0
    marker = os.path.splitext(path)[0] + ".offered"
    if os.path.exists(marker):
        return 0
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(marker, "w"):
            pass
    except Exception:
        return 0
    return speak(payload, (
        "This conversation is keeping no work plan. You have spoken %d times and this turn used %d tools, which is "
        "long enough for the thread it started on to be out of sight. If the work has more than one strand to come "
        "back to, start one at %s now - the skill agent-work-plan:maintain says what a row holds and what the states "
        "mean. This is said once per conversation and will not be raised again." % (turns, tools, path)))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    started, tools, turns, reached = turn_shape(payload.get("transcript_path") or "", path)
    if not started:
        return 0
    if not os.path.exists(path):
        return offer_once(payload, path, tools, turns, limits)
    if tools < limits["nudgeMinToolCalls"]:
        return 0
    # Reading the plan settles it as much as writing does. Reconciling begins by looking, and a turn that looked and
    # found nothing owed has reconciled - there is nothing else it could do. Without this the reminder had no way to
    # be answered: reading leaves no mark on the file, so it repeated on every working turn for the rest of a
    # conversation whose plan was already correct, which is precisely how a reminder stops being read.
    if reached:
        return 0
    began = iso_to_epoch(started)
    if began is None:
        return 0
    try:
        touched = os.stat(path).st_mtime
    except Exception:
        return 0
    if touched >= began:
        return 0
    return speak(payload, (
        "This turn used %d tools and neither read nor updated the work plan (%s). Reconcile it before finishing: add "
        "what this turn opened, close what it finished, and leave the rest alone. Reading it and finding nothing owed "
        "is a complete answer, but read it in the turn so this can tell. Only the user's word moves a row to "
        "\"todo\"." % (tools, path)))


if __name__ == "__main__":
    sys.exit(main())

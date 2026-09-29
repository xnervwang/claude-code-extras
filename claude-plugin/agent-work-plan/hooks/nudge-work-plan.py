#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Say something when a turn did real work and left the work plan untouched.

The skill says when to update the plan. This exists because a rule about noticing a state change is the kind that fails
in the moment it is needed - the same reason the injection hook exists rather than trusting the skill to be loaded.

It is deliberately hard to trigger. A reminder that fires when nothing was owed teaches the reader to skip it, and a
skipped reminder is worse than none: it costs attention on every turn and buys nothing on the turn that matters. So it
speaks only when the turn changed something AND the plan is older than the turn.

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

from plan_path import plan_file

# Below this a turn is conversational - a question answered, a file read - and owes the plan nothing.
MIN_TOOL_CALLS = 4
# What a turn has to cost before a conversation with no plan at all is told it could keep one. Measured over 691 turns
# taken from 120 transcripts: the median turn uses 6 tools and the upper quartile begins at 25, so a turn this size is
# among the busiest quarter. At this setting 58 conversations in 100 hear the sentence once and the other 42 never do.
FIRST_PLAN_TOOL_CALLS = 25


def turn_shape(transcript):
    """When this turn began, and how many tools it used.

    The turn begins at the last message the user sent, so the transcript is walked from the end and stops there. Reading
    it whole would mean parsing megabytes on every turn.
    """
    try:
        with open(transcript, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            window = min(size, 2 * 1024 * 1024)
            fh.seek(size - window)
            lines = fh.read().decode("utf-8", "replace").split("\n")
    except Exception:
        return None, 0
    started, tools = None, 0
    for line in reversed(lines):
        if '"type"' not in line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get("type") == "user" and isinstance((row.get("message") or {}).get("content"), (str, list)):
            content = (row.get("message") or {}).get("content")
            # A tool result is also recorded as a user message; only a real message ends the walk.
            if isinstance(content, str) or any(
                    isinstance(b, dict) and b.get("type") == "text" for b in content):
                started = row.get("timestamp")
                break
        if '"tool_use"' in line:
            tools += 1
    return started, tools


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


def offer_once(payload, path, tools):
    """Tell a conversation that has no plan that it could keep one, at most one time.

    Having offered is remembered as an empty file beside where the plan would go: this is a new process on every turn
    and has nowhere else to put it. If the marker cannot be written the offer is not made at all - saying it on every
    turn instead is the one outcome worth avoiding, and a directory that refuses the marker would refuse the plan too.
    """
    if tools < FIRST_PLAN_TOOL_CALLS:
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
        "This conversation is keeping no work plan, and this turn used %d tools. If the work has more than one strand "
        "to come back to, start one at %s now - the skill agent-work-plan:maintain says what a row holds and what the "
        "states mean. This is said once per conversation and will not be raised again; a conversation that is one "
        "question and one answer does not need a plan." % (tools, path)))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    started, tools = turn_shape(payload.get("transcript_path") or "")
    if not started:
        return 0
    if not os.path.exists(path):
        return offer_once(payload, path, tools)
    if tools < MIN_TOOL_CALLS:
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
        "This turn used %d tools and did not touch the work plan (%s). Reconcile it before finishing: add what "
        "this turn opened, close what it finished, and leave the rest alone. Only the user's word moves a row to "
        "\"todo\"." % (tools, path)))


if __name__ == "__main__":
    sys.exit(main())

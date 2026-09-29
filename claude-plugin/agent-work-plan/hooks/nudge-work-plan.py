#!/usr/bin/env python3
"""Say something when a turn did real work and left the work plan untouched.

The skill says when to update the plan. This exists because a rule about noticing a state change is the kind that fails
in the moment it is needed - the same reason the injection hook exists rather than trusting the skill to be loaded.

It is deliberately hard to trigger. A reminder that fires when nothing was owed teaches the reader to skip it, and a
skipped reminder is worse than none: it costs attention on every turn and buys nothing on the turn that matters. So it
speaks only when the turn changed something AND the plan is older than the turn.
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


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    path = plan_file(payload)
    if not path:
        return 0
    # A conversation that keeps no plan is not nagged into starting one: that is the skill's call, not a hook's.
    if not os.path.exists(path):
        return 0
    started, tools = turn_shape(payload.get("transcript_path") or "")
    if tools < MIN_TOOL_CALLS or not started:
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
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": payload.get("hook_event_name", "Stop"),
        "additionalContext": (
            "This turn used %d tools and did not touch the work plan (%s). Reconcile it before finishing: add what "
            "this turn opened, close what it finished, and leave the rest alone. Only the user's word moves a row to "
            "\"todo\"." % (tools, path)),
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

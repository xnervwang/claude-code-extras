#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Say something when a turn did real work and left the work plan untouched.

The skill says when to update the plan. This exists because a rule about noticing a state change is the kind that fails
in the moment it is needed - the same reason the injection hook exists rather than trusting the skill to be loaded.

It is deliberately hard to trigger. A reminder that fires when nothing was owed teaches the reader to skip it, and a
skipped reminder is worse than none: it costs attention on every turn and buys nothing on the turn that matters. So it
speaks only when the turn changed something, the plan is older than the turn, the turn never went to the plan at all,
AND this has not already been said about a plan in exactly this state.

"Changed something" is counted as things altered, not tool calls made. That distinction is the whole difference between
a reminder worth reading and one worth skipping: a turn spent reading, searching and measuring makes plenty of calls and
owes the plan nothing, and 18 of 29 reminders in the conversation that prompted this went to turns of exactly that kind.

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

WHICH SESSIONS THIS REACHES, and why detached agents are not a cost worth engineering against.

A sub-agent started in-process shares the main session's id, and these hooks do not run for it at all: measured over
three of them in one conversation, zero injections against the main session's 330. So a sub-agent neither sees the plan
nor is reminded of it, and whatever it did has to be recorded by the session that dispatched it.

A detached agent - one started as its own process - does get the hooks, because it has a session id of its own. It
therefore has no plan file, which puts it on the branch above, and that was briefly expensive: 53 of them were offered a
plan inside half an hour. What stopped it was not a check for detached agents but the requirement that the user have
spoken several times, added three hours later. A detached agent is handed one task and nothing else, so it counts one
user turn against a threshold of three and is silent for the rest of its life. No measured offer to one has happened
since, and nothing here identifies such a session or needs to.

Which is the part worth keeping: the question "can this conversation branch" subsumes "is this a detached worker", so
there is no second mechanism to maintain. Tightening the first threshold is what to reach for if these ever turn up
again, rather than adding a way to recognise them - there is no payload field verified to distinguish one, and looking
for a signal that happens to correlate is how a check starts passing for the wrong reason.
"""
import json
import os
import sys

# Set before the import below: see inject-work-plan.py. A hook that runs on every turn leaves no bytecode behind in the
# installed plugin directory.
sys.dont_write_bytecode = True

from changes import changes
from plan_path import (NUDGED_SUFFIX, OFFERED_SUFFIX, epoch, open_tail, plan_file, settings, side_file, turn_began,
                       write_quietly)

# Every threshold this uses is in plan_path.DEFAULTS, where the editor's settings can override it.

# How far back from the end of the transcript the turn, and the user's turns before it, are looked for.
TURN_TAIL = 2 * 1024 * 1024


def changed(row):
    """How many things this row altered. Zero for a row that only looked at something."""
    content = (row.get("message") or {}).get("content")
    if not isinstance(content, list):
        return 0
    return sum(1 for block in content
               if isinstance(block, dict) and block.get("type") == "tool_use"
               and changes(block.get("name") or "", block.get("input")))


def spoke(row):
    """True for a user row that is a real message, not a tool result or a row the client wrote.

    All of these are recorded as `user`. Rows the client writes are marked isMeta (skill text, scheduled wake-ups,
    image-resize notes) or isCompactSummary (compaction summaries), and an interruption is a line of its own that starts
    "[Request interrupted". Counted as the user, one transcript showed 180 more turns than were spoken, a skill loaded
    at the end of a turn would move the turn's start past all its work, and a worker addressed once looked addressed
    three times after two compactions.
    """
    if row.get("type") != "user" or row.get("isMeta") or row.get("isCompactSummary"):
        return False
    message = row.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        texts = [str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if not texts:
            return False
        content = "".join(texts)
    return isinstance(content, str) and not content.lstrip().startswith("[Request interrupted")


def turn_shape(tail, plan="", began=None):
    """Shape of the current turn: (start time in epoch seconds, tool calls, changes, user turns, whether a tool call
    went to the plan).

    With a plan, `began` (plan_path.turn_began) marks the turn's start and the backward walk stops at the first older
    line, without counting turns; otherwise the turn starts at the user's last message. Only the tail is read, and only
    lines that may be a tool call or a user message are parsed, since the whole file can be megabytes.

    That tail is also where the count of turns comes from, and it is a lower bound rather than a total: a conversation
    long enough to overflow the window has more turns than are visible here. The bound is in the safe direction - it can
    only make this quieter, and being too quiet costs a reminder while being too loud costs every reminder's credibility.

    Going to the plan is looked for ONLY in the calls the assistant made, never anywhere else in the turn. The path is
    also in the text this plugin injects at the start of every turn, so a search across whole rows would find it every
    time and the reminder would never be able to fire at all.
    """
    started, tools, changes, turns, reached = began, 0, 0, 0, False
    in_turn = True
    for line in tail.lines(TURN_TAIL):
        used_tool = '"tool_use"' in line
        if not used_tool and '"user"' not in line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        if began is not None:
            at = epoch(row.get("timestamp"))
            if at is not None and at < began:
                break
        elif spoke(row):
            turns += 1
            if in_turn:
                in_turn, started = False, epoch(row.get("timestamp"))
            continue
        if in_turn and used_tool:
            tools += 1
            changes += changed(row)
            if plan and plan in line:
                reached = True
    return started, tools, changes, turns, reached


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
    marker = side_file(path, OFFERED_SUFFIX)
    if os.path.exists(marker):
        return 0
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except Exception:
        return 0
    if not write_quietly(marker, ""):
        return 0
    return speak(payload, (
        "This conversation is keeping no work plan. You have spoken %d times and this turn used %d tools, which is "
        "long enough for the thread it started on to be out of sight. If the work has more than one strand to come "
        "back to, start one at %s now - the skill agent-work-plan:maintain says what a row holds and what the states "
        "mean. This is said once per conversation and will not be raised again." % (turns, tools, path)))


def said_already(path, touched):
    """True when this was already said about a plan in exactly this state, and saying it again would add nothing.

    What is remembered is the plan's modification time at the moment of speaking. If the plan has not been written to
    since, the reminder would be the same sentence about the same unrecorded state - and a reminder that did not work
    the first time does not work on the fifth. Measured over one conversation, the reminder fired 29 times and ten of
    those were runs of it repeating within a few turns; not one of the repeats produced an entry that the first had not.

    A plan that HAS been written to since resets this, so forgetting again is caught again.

    Counting turns instead would be the obvious shape and does not work: the turn count comes from the tail of the
    transcript rather than the whole of it, so it stops being monotonic once a conversation outgrows that window, and a
    counter that can go down cannot express a cooldown. A modification time only moves forward.

    Failing to read or write the marker means speaking. Silence is the outcome worth being sure about.
    """
    marker = side_file(path, NUDGED_SUFFIX)
    try:
        with open(marker) as fh:
            if fh.read().strip() == repr(touched):
                return True
    except Exception:
        pass
    write_quietly(marker, repr(touched))
    return False


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
    tail = open_tail(payload.get("transcript_path"))
    if tail is None:
        return 0
    if not os.path.exists(path):
        # Offered once already: nothing left to say, and nothing worth reading the transcript for.
        if os.path.exists(side_file(path, OFFERED_SUFFIX)):
            return 0
        started, tools, _, turns, _ = turn_shape(tail)
        if started is None:
            return 0
        return offer_once(payload, path, tools, turns, limits)
    started, tools, changes, turns, reached = turn_shape(tail, path, turn_began(path, payload))
    if started is None:
        return 0
    if changes < limits["nudgeMinChanges"]:
        return 0
    # Reading the plan settles it as much as writing does. Reconciling begins by looking, and a turn that looked and
    # found nothing owed has reconciled - there is nothing else it could do. Without this the reminder had no way to
    # be answered: reading leaves no mark on the file, so it repeated on every working turn for the rest of a
    # conversation whose plan was already correct, which is precisely how a reminder stops being read.
    if reached:
        return 0
    try:
        touched = os.stat(path).st_mtime
    except Exception:
        return 0
    if touched >= started:
        return 0
    if said_already(path, touched):
        return 0
    return speak(payload, (
        "This turn changed %d things and neither read nor updated the work plan (%s). Reconcile it before finishing: "
        "add what this turn opened, close what it finished, and leave the rest alone. Reading it and finding nothing "
        "owed is a complete answer, but read it in the turn so this can tell. Only the user's word moves a row to "
        "\"todo\". This will not be said again until the plan has been written to." % (changes, path)))


if __name__ == "__main__":
    sys.exit(main())

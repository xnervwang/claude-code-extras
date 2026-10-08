# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Where this conversation keeps its work plan, and the few facts about it that more than one script needs.

Shared rather than written into each: one hook reads the file, another watches its timestamp, a third reads a mark the
first leaves beside it, and the command that changes a row writes it - so two copies of any of this that drifted apart
would leave one of them looking at a path, a state or a mark that nobody writes, and nothing would say so.
"""
import datetime
import json
import os
import re
import sys

# The platform gives every plugin a data directory named <plugin>-<marketplace>, and hooks.json passes ours in as
# ${CLAUDE_PLUGIN_DATA}. This is that same name spelled out, for the case where the expansion did not happen. It is
# also the one directory the VS Code extension reads, so falling back to it keeps the two halves looking at one place.
FALLBACK = os.path.join(os.path.expanduser("~"), ".claude", "plugins", "data", "agent-work-plan-claude-code-extras")

# The states a row can be in, in the order a row usually passes through them. The extension's view keeps the same list
# (STATES in src/workplan.js) and the skill tabulates it; test/check.js holds the three together.
STATES = ("discussing", "todo", "doing", "waiting", "parked", "done", "dropped")
# The ones that still need something done.
OPEN_STATES = ("discussing", "todo", "doing", "waiting", "parked")
CLOSED_STATES = ("done", "dropped")


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
    # How many things a turn has to have CHANGED before it owes the plan anything - asked by the reminder at the end of a
    # turn, and by the one that speaks when a turn starts working with nothing marked `doing`. Counting tool calls
    # instead was the first shape of this and it was the wrong measure: reading, grepping and measuring are all tool
    # calls, so a turn spent explaining or investigating tripped the same threshold as a turn that finished three tasks.
    # Measured over one conversation, 29 reminders produced 10 entries and 18 produced nothing, and the densest run of
    # them landed on turns that had changed nothing at all. Meanwhile 14 other conversations kept a plan, wrote to it 269
    # times between them, and never saw one reminder - what maintains a plan is having it in front of the model every
    # turn, not this.
    "nudgeMinChanges": 2,
    # How many tool calls a turn makes, besides the plan's own, before the reminder that work has started with nothing
    # marked `doing` speaks, whether or not those calls changed anything. That reminder asks a different question from
    # the one at the end of a turn: not whether the plan is owed an entry, but whether the tree shows what is being worked
    # on right now, and the injection counts looking into something as work to mark. So reading and searching count
    # here, and nudgeMinChanges still lets two changes in a turn's first batch be enough on their own.
    "remindMinCalls": 3,
    # What a turn has to cost before a conversation with no plan at all is told it could keep one. The upper quartile of
    # turns begins at 25 tool calls, measured over 691 of them.
    "offerMinToolCalls": 25,
    # How many times the user has to have spoken first. A plan is for a conversation that branches, and a session handed
    # one task and left to do it cannot branch - measured over 61 offers, 53 went to single-turn workers and none of
    # them wanted a plan, while every conversation that did want one had spoken at least three times.
    "offerMinTurns": 3,
    # A regular expression for the conversation's latest reply. When it matches, the two hooks around a compaction say
    # nothing. It is for a conversation that relays another model's replies word for word: an instruction injected there
    # is either relayed to a model that cannot act on it or obeyed by breaking the relay. Empty matches nothing.
    "quietWhenReplyMatches": "",
}


def settings(directory=None):
    """The numbers above, with anything the extension wrote on top. A bad value is ignored rather than fatal.

    `directory` is for a caller that is not a hook and so is not handed the data directory as its first argument: the
    command that changes a row is given the plan's own path, and the plan sits in that directory.
    """
    out = dict(DEFAULTS)
    try:
        with open(os.path.join(directory or data_dir(), SETTINGS_FILE), encoding="utf-8") as fh:
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
        if isinstance(fallback, str):
            if isinstance(value, str):
                out[key] = value
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if value >= 1:
            out[key] = int(value)
    return out


"""How long a row's description may be, and the one test of it.

The view cuts a description at this length, the guard refuses a write past it, and the row command refuses to set one
past it. Kept the same as MAX_DETAIL_LINES and MAX_DETAIL_CHARS in the extension's src/workplan.js and as the numbers the
skill quotes; test/check.js asserts they are equal - a gate that refuses at one length while the view cuts at another
would be a gate nobody could satisfy.
"""
MAX_DETAIL_LINES = 12
MAX_DETAIL_CHARS = 900


def detail_over(value):
    """How a description breaks the limit, or None. Mirrors detail() in the extension's src/workplan.js.

    The character count is taken over the lines that would survive, not over the whole value, because that is what the
    view measures after dropping the rest - counting the whole thing would refuse a description the view shows in full.
    """
    lines = str(value).strip().split("\n")
    kept = "\n".join(lines[:MAX_DETAIL_LINES])
    if len(lines) > MAX_DETAIL_LINES:
        return "%d lines" % len(lines)
    if len(kept) > MAX_DETAIL_CHARS:
        return "%d characters" % len(kept)
    return None


def latest_reply_matches(transcript_path, pattern, tail=256 * 1024):
    """Whether the newest reply with any text in it matches `pattern`. False for an empty or unusable pattern.

    Turns made of tool calls alone are passed over, so a relayed reply followed by a few commands still counts as the
    latest one. Only the tail of the transcript is read: the answer is always near its end, and a transcript runs to
    hundreds of megabytes.
    """
    if not pattern:
        return False
    try:
        rx = re.compile(pattern)
    except re.error:
        return False
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as fh:
            fh.seek(max(0, size - tail))
            chunk = fh.read().decode("utf-8", "replace")
    except (OSError, TypeError):
        return False
    for line in reversed(chunk.split("\n")):
        if '"assistant"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("type") != "assistant":
            continue
        content = (row.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        text = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        if text.strip():
            return bool(rx.search(text))
    return False


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


def now_stamp():
    """The time now, written the way every time in a plan is written."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")


def epoch(stamp):
    """A time from a plan as seconds, or None for absent and for anything unparseable.

    Times are written by hand as often as by a script, so more than one spelling turns up: `date -Is` on some systems
    leaves the colon out of the offset, which the parser in this Python does not accept. A time with no offset at all is
    taken as UTC, which is what every script here writes.
    """
    m = STAMP.match(stamp.strip()) if isinstance(stamp, str) else None
    if not m:
        return None
    zone = m.group(3) or "+00:00"
    if zone == "Z":
        zone = "+00:00"
    elif ":" not in zone:
        zone = zone[:3] + ":" + zone[3:]
    try:
        return datetime.datetime.fromisoformat("%sT%s%s" % (m.group(1), m.group(2), zone)).timestamp()
    except ValueError:
        return None


"""The mark the injection hook leaves beside the plan when a turn begins, for the hook that watches the turn.

That second hook runs after every batch of tool calls and needs facts it cannot see from where it stands: when this turn
began, so that it can tell whether the plan has been written since; how much the turn has changed so far; and whether it
has already spoken. All three belong to the turn rather than to the plan, so they are kept beside the plan rather than in
it - the plan is the user's and the model's file, and no hook writes to it.

A turn is named by the prompt id the platform puts on every hook's input: one id from a prompt until the next, the same on
every event in between. A mark carrying any other id is from an earlier turn, and reads as no mark at all.
"""
TURN_SUFFIX = ".turn"


def turn_file(plan):
    return os.path.splitext(plan)[0] + TURN_SUFFIX


def read_turn(plan):
    try:
        with open(turn_file(plan), encoding="utf-8") as fh:
            turn = json.load(fh)
    except Exception:
        return None
    return turn if isinstance(turn, dict) else None


def write_turn(plan, turn):
    """Write the mark whole and rename it into place, so a reader never sees half of it. True when it is there."""
    path = turn_file(plan)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(turn, fh)
        os.replace(tmp, path)
        return True
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass
        return False

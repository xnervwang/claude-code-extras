#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Before an automatic compaction, ask for the descriptions of the `doing` rows to be brought up to date.

A compaction replaces the conversation with a summary, and a summary keeps coverage rather than emphasis: it is ordered
by kind - intent, concepts, files, errors - with the current work near the end, and it retells verdicts instead of
stating them. What the next turn needs in order to carry on is narrower than that and has to be written for that moment:
for each row being worked on, the exact next step, what not to do, and the user's own words that are written nowhere
else. The `detail` of the row is where that goes, and the plan is what gets read after the compaction (see
resume-work-plan.py).

The moment to write it cannot be seen from inside the conversation: how full the context is lives in the client's status
line and is never put in front of the model. So this measures it from the transcript and speaks when it crosses a mark.

Several marks per window
------------------------
Three for each window size, arranged around its compaction line - see MARKS_ANY_WINDOW for the arithmetic. One mark is a
tripwire a fast climb steps over: a single batch of tool results has moved a session by more than 200,000 tokens. Two
before the line make a net - a fast climb trips the earlier one, a slow one reaches the later one and gets a fresher
update - and the third sits after the line for a compaction that arrives late.

Each mark fires once. A compaction is detected when the measured context drops below a mark that has already fired: the
marks then reset and fire again on the next climb. If a mark fired and the plan has not been written since while a row
is `doing`, the reminder is repeated once at the end of the turn, because the point is to have the plan current before
the client compacts. It is repeated only once because a Stop hook's output keeps the turn from ending: repeating it at
every Stop would add another model call on a nearly full context each time, up to the eight in a row the client allows
before it overrides the hook.

Context size is the newest model call's usage plus the tool results written after it, which no call has carried yet.
Those are counted by what the results say, at four bytes a token; the transcript line they sit on also carries the
client's own copy of each and JSON's escaping, about four times as much again. When the newest call is further back than
the hook reads, the last context it measured, kept in the state file, stands in for the one it cannot see. That happens
only when tool results alone fill that much of the transcript, the fastest the context can grow.

This does not try to trigger the compaction. A hook can post nothing into a session's input channel, and /compact only
behaves as a command when it arrives through that one; the client's own scheduler can, but it is off in the panel
entrypoint and its lock is per working directory, so with several sessions under one directory only the first one's
tasks ever run. It is not needed either: the marks sit before the line, so the plan is current when the client compacts
on its own, and the client resumes the conversation afterwards by itself.

Two events
----------
Stop runs once, when the turn hands control back, and a turn can make dozens of model calls before that - one turn went
from 190,000 to 820,000 and was compacted twice with a Stop hook never called. So PostToolBatch checks inside the turn
too. It only asks: whether the plan was written after the request can only be judged once that turn is over, so saying
it again is Stop's alone.

A conversation with no plan hears nothing from this. Whether one should keep a plan is the end-of-turn hook's call
(nudge-work-plan.py), made once and only for a conversation that branches; a worker handed one task that happens to read
a lot is exactly what that hook was measured not to bother.

Fail open on everything: a hook that runs after every batch must never be the reason a session stops working.
"""
import json
import os
import re
import sys
import time

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True

from plan_path import (MAX_DETAIL_CHARS, MAX_DETAIL_LINES, TAIL_MAX, WATERMARK_SUFFIX, any_in, latest_reply_matches,
                       listed, open_tail, plan_file, row_command, settings, side_file, usage_of, write_quietly)

# Three marks per window size, arranged around that window's compaction line:
#
#   200K window   170_000  180_000  195_000   compacts at 187_000   blocked at 197_000
#   1M window     960_000  970_000  995_000   compacts at 987_000   blocked at 997_000
#
# Where the compaction line comes from: with no percentage override the client computes it as window - 13_000. With
# CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set it is min(window * pct / 100, window - 13_000), which only ever lowers the line, so
# every mark of that window moves down by the same amount (see marks_for). Left as they are, the earlier marks would sit
# past the line and stop being marks before a compaction, which is the only reason they exist.
#
# The last mark of each group sits past the line on purpose: the client does not always compact the instant the line is
# crossed - one session ran to 999,910 against a line of 987,000 - so that mark catches a late compaction.
MARKS_ANY_WINDOW = (170_000, 180_000, 195_000)
MARKS_1M_ONLY = (960_000, 970_000, 995_000)
WINDOWS = ((200_000, MARKS_ANY_WINDOW), (1_000_000, MARKS_1M_ONLY))
RESERVE = 13_000

# A context this large settles the window on its own: a 200K window compacts at 187,000 and is blocked at 197,000, so a
# session reporting more than this is on a 1M window whatever the transcript says about the model. Below it nothing is
# proved, since a 1M session spends its first 200,000 tokens there too.
STANDARD_WINDOW_CEILING = 200_000

# Bounds for finding the model identity, which is looked for only between the first standard-window mark and
# STANDARD_WINDOW_CEILING, the one band where it changes the outcome. The identity attachment is in a session's first
# rows, and a session that switched models writes another where it switched, possibly megabytes from the end; if the
# switch is beyond the tail read, the window is undecided and gets the standard marks too, at the cost of one early
# request. The decision is cached in the state file and reused as long as no identity attachment or cost row has been
# written since and the transcript has grown by less than ATTACHMENT_TAIL, so a session in that band does not reread
# four megabytes after every batch.
ATTACHMENT_HEAD = 1024 * 1024
ATTACHMENT_TAIL = 3 * 1024 * 1024
COST_STATE_MAX = 1024 * 1024

# How many bytes of a tool result make a token, for results no model has been sent yet. About right for English and
# code; an under-estimate for CJK text, which the marks before the compaction line leave room for.
BYTES_PER_TOKEN = 4

# The context is kept in the state file only to this precision, so the file changes every few thousand tokens rather than
# after every batch. It is only used when the newest call cannot be found, and then as a floor.
CONTEXT_STEP = 5_000


def compaction_line(window, env=None):
    env = os.environ if env is None else env
    line = window - RESERVE
    try:
        pct = float(env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", ""))
    except ValueError:
        return line
    if 0 < pct <= 100:
        line = min(int(window * pct / 100), line)
    return line


def marks_for(env=None):
    """(marks of the 200K window, marks of the 1M window), each moved down with its compaction line."""
    out = []
    for window, marks in WINDOWS:
        shift = compaction_line(window, env) - (window - RESERVE)
        out.append(tuple(m + shift for m in marks))
    return out[0], out[1]


def head_rows(path, window):
    with open(path, "rb") as fh:
        return fh.read(window).decode("utf-8", "replace").split("\n")


def text_bytes(value):
    """Bytes of the text in a tool result's content, which is either a string or a list of blocks."""
    if isinstance(value, str):
        return len(value.encode("utf-8", "replace"))
    return sum(len(str(b.get("text", "")).encode("utf-8", "replace"))
               for b in listed(value) if isinstance(b, dict) and b.get("type") == "text")


def result_bytes(line):
    """Byte length of the tool_result content on one transcript line; the client's own copy elsewhere on the row is not
    counted."""
    try:
        row = json.loads(line)
    except ValueError:
        return 0
    message = row.get("message") if isinstance(row, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    return sum(text_bytes(b.get("content")) for b in listed(content) if isinstance(b, dict) and b.get("type") == "tool_result")


def context_of(tail):
    """(tokens sent on the newest model call or None, tokens of the tool results written since and not yet sent).

    A usage figure only counts what a model has already been given, so a batch whose results sit in the transcript adds
    nothing to it - and then all of it arrives at once. That is how a session goes from 109,603 to 487,753 tokens between
    two consecutive calls.
    """
    pending = 0
    for line in tail.lines(TAIL_MAX):
        tokens = usage_of(line)
        if tokens is not None:
            return tokens, pending // BYTES_PER_TOKEN
        if '"tool_result"' in line:
            pending += result_bytes(line)
    return None, pending // BYTES_PER_TOKEN


def latest_bare_model(tail):
    """The model on the most recent assistant message: the bare name, without the [1m] suffix, but certainly current."""
    for line in tail.lines(TAIL_MAX):
        if '"model"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("type") != "assistant":
            continue
        m = (row.get("message") or {}).get("model")
        if isinstance(m, str) and m and not m.startswith("<"):
            return m
    return None


def decide_variant(bare, candidates):
    """Whether `candidates` say `bare` runs as a 1M variant; None when none of them refers to it, or both variants do.

    A candidate can carry a Bedrock cross-region prefix (global.anthropic.claude-opus-4-8[1m]) while the bare name never
    does. Model names contain no dot, so keeping what follows the last one normalises the prefixed form. Both variants
    turn up when the session moved between them, and in the cost rows (which cover the whole session) even when it did
    not; then these cannot tell which is current.
    """
    matching = {c.rsplit(".", 1)[-1] for c in candidates}
    one_m, standard = bare + "[1m]" in matching, bare in matching
    return None if one_m == standard else one_m


def attachment_model(line):
    """modelId from a model-identity attachment on this line, or None if the line is not one."""
    if '"marketingName"' not in line and '"type":"model"' not in line:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    att = row.get("attachment") if isinstance(row, dict) else None
    if not isinstance(att, dict) or att.get("type") != "model":
        return None
    mid = (att.get("identity") or {}).get("modelId")
    return mid if isinstance(mid, str) and mid else None


def model_attachments(tail):
    """Every modelId the transcript's model-identity attachments carry, from its head and its tail."""
    found = []
    try:
        head = head_rows(tail.path, ATTACHMENT_HEAD)
    except OSError:
        head = []
    for rows in (head, tail.lines(ATTACHMENT_TAIL)):
        for line in rows:
            mid = attachment_model(line)
            if mid and mid not in found:
                found.append(mid)
    return found


def on_1m_window(tail, bare=None):
    """True on a 1M-context model, False on a standard one, None if it cannot be told.

    The transcript keeps the suffix that decides the window in two places: the model-identity attachment, near the start
    and wherever the model was switched, and the cost-state rows, which exist only once cost is accounted. Both are
    checked against the bare name on the latest reply, so an identity left over from before a switch decides nothing.
    Uncertainty resolves towards the standard window: a standard session given only the 1M marks could never reach any of
    them, would never be asked, and would show no sign of having failed.
    """
    bare = bare or latest_bare_model(tail)
    if not bare:
        return None
    verdict = decide_variant(bare, model_attachments(tail))
    if verdict is not None:
        return verdict
    for line in tail.lines(COST_STATE_MAX):
        if '"modelUsage"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        mu = row.get("modelUsage") if isinstance(row, dict) else None
        if isinstance(mu, dict) and mu:
            return decide_variant(bare, list(mu))
    return None


def evidence_since(tail, offset):
    """Whether anything on_1m_window reads (a model-identity attachment or a cost row) has been written since the
    transcript was `offset` bytes long."""
    return any(attachment_model(line) or '"modelUsage"' in line for line in tail.lines(tail.size - offset + 1))


VERDICTS = {True: "1M", False: "standard", None: "unknown"}


def window_of(tail, state):
    """on_1m_window, or its cached answer while that is still valid (the conditions are at ATTACHMENT_HEAD)."""
    bare = latest_bare_model(tail)
    if not bare:
        return None
    kept = state["window"]
    if kept and kept[1] == bare and 0 <= tail.size - kept[2] <= ATTACHMENT_TAIL and not evidence_since(tail, kept[2]):
        return kept[0]
    verdict = on_1m_window(tail, bare)
    state["window"] = (verdict, bare, tail.size)
    return verdict


def state_path(plan):
    """Beside the plan, like the other marks the hooks leave, and swept with it when the conversation is gone."""
    return side_file(plan, WATERMARK_SUFFIX)


def marks_in(text, key):
    m = re.search(r"^- %s:[ \t]*(.*)$" % key, text, re.M)
    return {int(p) for p in (m.group(1).split(",") if m else []) if p.strip().isdigit()}


def read_state(path):
    """The hook's saved state: which marks have fired, the last measured context, and the last window decision. An
    unreadable file counts as empty state; at worst that repeats one request, whereas guessing from damaged input could
    suppress one."""
    state = {"fired": set(), "asked_at": None, "nagged": set(), "context": None, "window": None}
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return state
    state["fired"] = marks_in(text, "fired")
    state["nagged"] = marks_in(text, "nagged")
    m = re.search(r"^- asked-at:[ \t]*([0-9]+(?:\.[0-9]+)?)$", text, re.M)
    if m:
        state["asked_at"] = float(m.group(1))
    m = re.search(r"^- context:[ \t]*([0-9]+)$", text, re.M)
    if m:
        state["context"] = int(m.group(1))
    m = re.search(r"^- window:[ \t]*(1M|standard|unknown)[ \t]+(\S+)[ \t]+([0-9]+)$", text, re.M)
    if m:
        verdict = {v: k for k, v in VERDICTS.items()}[m.group(1)]
        state["window"] = (verdict, m.group(2), int(m.group(3)))
    return state


def copy_state(state):
    return dict(state, fired=set(state["fired"]), nagged=set(state["nagged"]))


def write_state(path, state, seen):
    marks = lambda values: ", ".join(str(v) for v in sorted(values))
    window = state["window"]
    body = (
        "# Water-mark state\n"
        "\n"
        "Written by the hook that watches this conversation's context size. `fired` are the marks that have already\n"
        "asked for the plan to be brought up to date, `asked-at` is when the most recent one asked, `nagged` the marks it\n"
        "has said again at the end of a turn or will not, `context` the last context it measured, `window` what it decided\n"
        "about the model's window and at what transcript size, and `last-checked` when it last changed any of these - its\n"
        "presence is how you tell it is wired up while it has nothing to say. The marks reset when a compaction brings the\n"
        "context back below one. Safe to delete.\n"
        "\n"
        "- fired: %s\n" % marks(state["fired"])
        + ("- asked-at: %.3f\n" % state["asked_at"] if state["asked_at"] else "")
        + ("- nagged: %s\n" % marks(state["nagged"]) if state["nagged"] else "")
        + ("- context: %d\n" % state["context"] if state["context"] is not None else "")
        + ("- window: %s %s %d\n" % (VERDICTS[window[0]], window[1], window[2]) if window else "")
        + "- last-checked: %s\n" % seen
    )
    write_quietly(path, body)


def has_doing(plan):
    """Whether any row of the plan is `doing`; the end-of-turn reminder asks for those rows to be described."""
    try:
        with open(plan, encoding="utf-8") as fh:
            body = json.load(fh)
    except Exception:
        return False
    return isinstance(body, dict) and any_in(body.get("nodes"), "doing")


def plan_written_since(plan, since):
    """Whether the plan was written after `since`. No hook writes the plan, so a newer time means the model or the user
    did - proof taken from the file system rather than from anything the turn claims."""
    if not since:
        return False
    try:
        return os.path.getmtime(plan) > since
    except OSError:
        return False


NOT_THE_USER = "This is a hook's output, not the user speaking: it approves nothing and answers no pending question."


def what_to_write(plan):
    command = row_command(plan)
    return ("For every row that is `doing`, set its description to what picking it up after a compaction needs: the "
            "exact next step, anything not to do, and the user's own words that are written nowhere else - at most %d "
            "lines and %d characters. Move any row whose state has changed.\n  %s set <row> --detail TEXT\n%s"
            % (MAX_DETAIL_LINES, MAX_DETAIL_CHARS, command, NOT_THE_USER))


def message(mark, ctx, plan, urgent):
    """Two wordings, split by whether the mark can only belong to a 1M window.

    A standard window cannot reach a 1M mark, so a session that does is on a 1M window and "a compaction is close" is safe
    to say. The standard marks are also what a 1M session gets when its window cannot be told, and there they are seven
    hundred thousand tokens early, so they say nothing about a compaction and only ask.
    """
    lead = ("The context has passed %s tokens (now about %s). " % (format(mark, ","), format(ctx, ","))
            + ("An automatic compaction is close, so bring" if urgent else "Bring"))
    return lead + " this conversation's work plan up to date before doing anything else. " + what_to_write(plan)


def nag(mark, ctx, plan, urgent):
    """The end-of-turn repeat, worded like message(): only a mark exclusive to 1M windows (`urgent`) says a compaction
    is near."""
    return ("The context is %s tokens, past the %s mark, and the work plan has not been written since that mark was "
            "reached. " % (format(ctx, ","), format(mark, ","))
            + ("An automatic compaction is a turn or two away, and what the `doing` rows do not say is left to a lossy "
               "summary when it lands. " if urgent else
               "What the `doing` rows do not say when a compaction lands is left to a lossy summary. ")
            + "Update it now. " + what_to_write(plan))


def emit(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}, ensure_ascii=False))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    event = payload.get("hook_event_name")
    if event not in ("Stop", "PostToolBatch"):
        return 0
    limits = settings()
    if not limits["enabled"]:
        return 0
    plan = plan_file(payload)
    if not plan or not os.path.isfile(plan):
        return 0
    tail = open_tail(payload.get("transcript_path"))
    if tail is None:
        return 0

    path = state_path(plan)
    state = read_state(path)
    before = copy_state(state)

    ctx, pending = context_of(tail)
    measured = ctx is not None
    if measured:
        state["context"] = ctx - ctx % CONTEXT_STEP
    elif pending:
        ctx = state["context"] or 0
    else:
        return 0
    ctx_next = ctx + pending

    # The window size is judged from the measured context only. The pending estimate is a guess, and one above 200,000
    # would drop the standard marks from a standard session.
    standard, one_m = marks_for()
    if ctx > STANDARD_WINDOW_CEILING:
        window_1m, label = True, "1M-by-size"
    elif ctx_next >= min(standard):
        window_1m = window_of(tail, state)
        label = VERDICTS[window_1m]
    else:
        window_1m, label = None, "not-needed"
    marks = one_m if window_1m else standard + one_m

    # Only marks currently in force count: a mark recorded under different settings stays in the file, and comparing
    # against one that no longer exists would keep a session from ever being asked again. The measured context is what
    # shows a compaction, since the first batch after one can bring a large estimate with it.
    live = state["fired"] & set(marks)
    if measured and live and ctx < min(live):
        state["fired"], state["asked_at"], state["nagged"] = set(), None, set()

    seen = "%s ctx=%d%s pending=%d window=%s event=%s" % (
        time.strftime("%Y-%m-%d %H:%M:%S"), ctx, "" if measured else " (last measured)", pending, label, event)
    reply = payload.get("last_assistant_message") if event == "Stop" else None

    def relaying():
        return latest_reply_matches(tail, limits["quietWhenReplyMatches"], reply)

    due = [m for m in marks if ctx_next >= m and m not in state["fired"]]
    if due:
        state["fired"] |= set(due)
        quiet = relaying()
        if quiet:
            # When relaying, the marks are used up without asking and also counted as already repeated, so a mark passed
            # long ago does not fire once the relay ends.
            state["nagged"] |= set(due)
        else:
            state["asked_at"] = time.time()
        write_state(path, state, seen)
        if not quiet:
            mark = max(due)
            emit(event, message(mark, ctx_next, plan, mark in one_m))
        return 0
    if state != before:
        write_state(path, state, seen)

    # Said at the end of a turn, once per mark, and never into the turn this hook's own output extended.
    if event != "Stop" or payload.get("stop_hook_active"):
        return 0
    behind = [m for m in sorted(state["fired"] & set(marks), reverse=True) if ctx_next >= m]
    if not behind or behind[0] in state["nagged"] or plan_written_since(plan, state["asked_at"]):
        return 0
    if relaying() or not has_doing(plan):
        return 0
    state["nagged"] |= set(behind)
    write_state(path, state, seen)
    emit(event, nag(behind[0], ctx_next, plan, behind[0] in one_m))
    return 0


def selftest():
    import shutil
    import subprocess
    import tempfile

    root = tempfile.mkdtemp(prefix="refresh-work-plan-selftest-")
    data = os.path.join(root, "data")
    os.makedirs(data)
    sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    plan = os.path.join(data, sid + ".json")
    state = state_path(plan)
    transcript = os.path.join(root, sid + ".jsonl")
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"}
    me = [sys.executable, os.path.abspath(__file__), data]

    def write_plan(stale, state="doing"):
        with open(plan, "w", encoding="utf-8") as fh:
            json.dump({"nodes": [{"title": "r", "state": state}]}, fh)
        if stale:
            os.utime(plan, (1, 1))

    def usage(tokens):
        return {"input_tokens": 2, "cache_read_input_tokens": tokens - 2, "cache_creation_input_tokens": 0}

    def write_transcript(ctx_tokens, relay=False, model=None, usage_keys=None, attachment_id=None,
                         pending_bytes=0, switched_to=None, pad_bytes=0, pending_lines=1, result_copy=False,
                         then_call=None):
        rows = []
        if attachment_id:
            rows.append({"type": "attachment", "attachment": {
                "type": "model", "identity": {"modelId": attachment_id, "marketingName": "x"}}})
        if switched_to:
            rows.append({"type": "attachment", "attachment": {
                "type": "model", "identity": {"modelId": switched_to, "marketingName": "y"}}})
        if pad_bytes:
            rows.append({"type": "user", "message": {"content": "p" * max(0, pad_bytes - 120)}})
        if usage_keys:
            rows.append({"type": "cost-state", "modelUsage": {k: {"inputTokens": 1} for k in usage_keys}})
        text = "(gpt-through-opus 2026-09-05T07:16:42Z) relayed" if relay else "an ordinary reply"
        rows.append({"type": "assistant", "message": {"content": [{"type": "text", "text": text}],
                                                      "usage": usage(ctx_tokens)}})
        if model:
            rows[-1]["message"]["model"] = model
        for _ in range(pending_lines if pending_bytes else 0):
            said = "x" * max(0, pending_bytes // pending_lines - 120)
            rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "content": said}]}})
            if result_copy:
                rows[-1]["toolUseResult"] = {"stdout": said}
        if then_call:
            rows.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}],
                                                          "usage": usage(then_call)}})
        with open(transcript, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")

    def hook(event="Stop", active=False, extra_env=None, extra=None):
        p = dict({"hook_event_name": event, "session_id": sid, "transcript_path": transcript}, **(extra or {}))
        if active:
            p["stop_hook_active"] = True
        r = subprocess.run(me, input=json.dumps(p), stdout=subprocess.PIPE, universal_newlines=True,
                           env=dict(env, **(extra_env or {})))
        return r.stdout.strip()

    def run(ctx_tokens, reset=False, event="Stop", active=False, extra_env=None, extra=None, **kw):
        if reset and os.path.exists(state):
            os.remove(state)
        write_transcript(ctx_tokens, **kw)
        return hook(event, active, extra_env, extra)

    def said(out):
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""

    def state_text():
        try:
            return open(state, encoding="utf-8").read()
        except OSError:
            return ""

    bad = 0

    def check(label, cond):
        nonlocal bad
        if not cond:
            bad += 1
        print("%-4s %s" % ("PASS" if cond else "FAIL", label))

    def drives_compaction(text):
        return "CronCreate" in text or "/compact" in text or "end the turn" in text

    # --- no plan: nothing at all ---
    check("no plan -> silent", run(171_000) == "")
    check("  and nothing is written beside where the plan would go", not os.path.exists(state))

    # --- the marks of one group fire in order, each once ---
    write_plan(stale=True)
    check("below the first mark -> silent", run(169_000, reset=True) == "")
    check("  but a heartbeat is recorded", "ctx=169000" in state_text())
    check("  and the identity is not looked for that far below the band", "window=not-needed" in state_text())
    c = said(run(171_000))
    check("crossing 170k -> asks for the plan to be brought up to date", "170,000" in c and "work plan" in c)
    check("  naming the row command with its description option and this plan",
          "plan-row.py" in c and "--detail" in c and plan in c)
    check("  without saying a compaction is close", "compaction is close" not in c)
    check("  and asking for nothing but the plan", not drives_compaction(c))
    check("crossing the next mark asks again, naming it", "180,000" in said(run(181_000)))
    check("the mark past the compaction line still asks", "195,000" in said(run(196_000)))

    # --- a mark that asked and was not answered ---
    c = said(run(196_500))
    check("plan not written since -> said again at the end of the turn", "has not been written since" in c)
    check("  and asking for nothing but the plan", not drives_compaction(c))
    check("  without saying a compaction is a turn or two away, which a standard mark cannot know",
          "a turn or two away" not in c)
    check("  but only once for that mark, since saying it keeps the turn from ending", run(196_600) == "")
    write_plan(stale=False)
    check("plan written -> silent", run(196_700) == "")

    # --- when the end of a turn stays quiet about a mark that was not answered ---
    write_plan(stale=True)
    run(171_000, reset=True, event="PostToolBatch")
    check("not said into the turn the hook's own output extended", run(172_000, active=True) == "")
    check("  but at the end of the next turn", "has not been written since" in said(run(172_500)))
    write_plan(stale=True, state="todo")
    run(171_000, reset=True, event="PostToolBatch")
    check("with no row `doing` there is no description to bring up to date -> not said", run(172_000) == "")
    write_plan(stale=True)

    # --- a compaction lands, and the climb back asks again ---
    check("after a compaction -> silent", run(6_000) == "")
    check("climbing back -> the first mark asks again", "170,000" in said(run(171_000)))

    # --- the 1M group ---
    c = said(run(961_000, reset=True))
    check("crossing 960k -> asks, and says a compaction is close", "960,000" in c and "compaction is close" in c)
    write_plan(stale=True)
    run(961_000, reset=True, event="PostToolBatch")
    check("  and said again at the end of a turn, says it is a turn or two away", "a turn or two away" in said(run(962_000)))
    check("a turn extended by a request is still checked", "170,000" in said(run(171_000, reset=True, active=True)))

    # --- relaying for another model ---
    relay = r"^\s*\([A-Za-z0-9._-]+-through-[A-Za-z0-9._-]+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)"
    with open(os.path.join(data, "config.json"), "w") as fh:
        json.dump({"quietWhenReplyMatches": relay}, fh)
    check("a reply matching the quiet pattern -> silent", run(171_000, reset=True, relay=True) == "")
    check("  and the mark is used up rather than left to speak later", "- fired: 170000" in state_text()
          and "- asked-at:" not in state_text() and "- nagged: 170000" in state_text())
    check("  so it is not said either once the relay has ended", run(172_000) == "")
    relayed = "(gpt-through-opus 2026-09-05T07:16:42Z) relayed"
    long_after = dict(relay=True, pending_bytes=1_200_000, pending_lines=24, then_call=171_000)
    check("the end of a turn reads the reply from the event, however much output came after it",
          run(171_000, reset=True, extra={"last_assistant_message": relayed}, **long_after) == "")
    check("  where the transcript alone could not tell", "170,000" in said(run(171_000, reset=True, **long_after)))
    check("an ordinary reply under the same pattern still asks", "170,000" in said(run(171_000, reset=True)))
    with open(os.path.join(data, "config.json"), "w") as fh:
        json.dump({"enabled": False}, fh)
    check("plans switched off -> silent", run(171_000, reset=True) == "")
    os.remove(os.path.join(data, "config.json"))

    r = subprocess.run(me, input="not json", stdout=subprocess.PIPE, universal_newlines=True, env=env)
    check("malformed input fails open", r.returncode == 0 and r.stdout.strip() == "")

    # --- telling the window apart, inside the band where it matters ---
    opus1m = dict(model="claude-opus-5", usage_keys=["claude-opus-5[1m]"])
    check("1M window -> silent at the standard marks", run(181_000, reset=True, **opus1m) == "")
    check("1M window -> asks at its own, naming the highest crossed", "970,000" in said(run(981_000, **opus1m)))
    check("standard window -> keeps its marks",
          "180,000" in said(run(181_000, reset=True, model="claude-sonnet-5", usage_keys=["claude-sonnet-5"])))
    check("both variants in the cost rows -> undecided, which keeps the standard marks", "180,000" in said(run(
        181_000, reset=True, model="claude-opus-5", usage_keys=["claude-opus-5", "claude-opus-5[1m]"]))
          and "window=unknown" in state_text())
    check("both variants among the identities -> undecided too", "180,000" in said(run(
        181_000, reset=True, model="claude-opus-5", attachment_id="claude-opus-5", switched_to="claude-opus-5[1m]"))
          and "window=unknown" in state_text())
    check("no identity naming the current model -> treated as standard", "180,000" in said(run(
        181_000, reset=True, model="claude-opus-5", usage_keys=["claude-fable-5"])))
    check("cross-region prefix still reads as 1M", run(
        181_000, reset=True, model="claude-opus-4-8", usage_keys=["global.anthropic.claude-opus-4-8[1m]"]) == "")
    check("attachment alone decides 1M", run(
        181_000, reset=True, model="claude-opus-5", attachment_id="claude-opus-5[1m]") == "")
    check("attachment beats a disagreeing cost-state row", run(
        181_000, reset=True, model="claude-opus-5", attachment_id="claude-opus-5[1m]",
        usage_keys=["claude-opus-5"]) == "")
    check("a switch a megabyte and a half back is still found", run(
        181_000, reset=True, model="claude-opus-5-5", attachment_id="claude-opus-5[1m]",
        switched_to="global.anthropic.claude-opus-5-5[1m]", pad_bytes=1_500_000) == "")

    # --- above the ceiling the size decides ---
    check("above 200,000 the window is 1M without reading any identity",
          run(354_884, reset=True, model="claude-sonnet-5", attachment_id="claude-sonnet-5") == ""
          and "window=1M-by-size" in state_text())

    # --- a lowered compaction line moves every mark of that window ---
    c = said(run(144_000, reset=True, extra_env={"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "80"}))
    check("with the line at 80%, the first standard mark moves to 143,000", "143,000" in c)
    c = said(run(172_000, extra_env={"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "80"}))
    check("  and the last one to 168,000, so 172,000 is past it rather than short of 170,000",
          "168,000" in c and "170,000" not in c)

    # --- unconsumed tool results count, by what they say ---
    check("120k + 30 KB pending is still under the mark -> silent", run(120_000, reset=True, pending_bytes=30_000) == "")
    check("150k + 160 KB of results pending crosses 180k -> asks",
          "180,000" in said(run(150_000, reset=True, pending_bytes=160_000)))
    check("the copy of a result kept for the client is not counted",
          run(155_000, reset=True, pending_bytes=10_000, result_copy=True) == "")
    c = said(run(150_000, reset=True, pending_bytes=300_000))
    check("a standard session with 300 KB of results pending keeps its marks", "195,000" in c
          and "window=unknown" in state_text())
    c = said(run(150_000, reset=True, pending_bytes=900_000))
    check("  and with 900 KB is not told it passed a 1M mark", "195,000" in c and "995,000" not in c)

    # --- a compaction, recognised from what was measured ---
    run(196_000, reset=True)
    check("after a compaction, a large first batch still lets the marks reset and ask again",
          "180,000" in said(run(30_000, pending_bytes=640_000)))

    # --- the newest call further back than the hook reads ---
    run(140_000, reset=True)
    c = said(run(140_000, pending_bytes=1_200_000, pending_lines=24))
    check("results that push the newest call out of reach still trip a mark, on the last context measured",
          "195,000" in c and "(last measured)" in state_text())
    check("  and with nothing measured before, the results alone trip it",
          "195,000" in said(run(140_000, reset=True, pending_bytes=1_200_000, pending_lines=24)))

    # --- the state file is written when something in it changes ---
    run(150_000, reset=True)
    os.utime(state, (1, 1))
    run(150_000)
    check("a run that changes nothing leaves the state file alone", os.path.getmtime(state) == 1)

    # --- the window, once decided, is remembered until something could change it ---
    def raw(rows, append=False):
        with open(transcript, "a" if append else "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")

    def call(tokens):
        return {"type": "assistant", "message": {"model": "claude-opus-5", "usage": usage(tokens),
                                                 "content": [{"type": "text", "text": "ok"}]}}

    def identity(mid):
        return {"type": "attachment", "attachment": {"type": "model", "identity": {"modelId": mid, "marketingName": "x"}}}

    if os.path.exists(state):
        os.remove(state)
    raw([identity("claude-opus-5[1m]"), call(181_000)])
    check("an identity decides the window", hook() == "" and "- window: 1M claude-opus-5 " in state_text())
    raw([{"type": "user", "message": {"content": "p" * 2_000}}, call(182_000)])
    check("  and what it decided stands while no identity has been written since", hook() == "")
    raw([identity("claude-opus-5"), call(183_000)], append=True)
    check("  until one is", "180,000" in said(hook()) and "- window: standard claude-opus-5 " in state_text())
    os.remove(state)
    raw([{"type": "cost-state", "modelUsage": {"claude-opus-5[1m]": {}}}, call(181_000)])
    check("a cost row decides it when no identity does", hook() == "" and "- window: 1M claude-opus-5 " in state_text())
    raw([{"type": "cost-state", "modelUsage": {"claude-opus-5[1m]": {}, "claude-opus-5": {}}}, call(184_000)], append=True)
    check("  and a later cost row naming both variants makes it undecided again", "180,000" in said(hook())
          and "- window: unknown claude-opus-5 " in state_text())

    # --- the in-turn event asks but never repeats itself ---
    write_plan(stale=True)
    out = run(181_000, reset=True, event="PostToolBatch")
    check("in-turn event asks too, under its own event name", "180,000" in said(out)
          and json.loads(out)["hookSpecificOutput"]["hookEventName"] == "PostToolBatch")
    check("  the in-turn event does not say it again", run(182_000, event="PostToolBatch") == "")
    check("  end of turn does, while the plan is unwritten", "has not been written since" in said(run(182_000)))
    write_plan(stale=False)
    check("plan written -> both events quiet", run(184_000, event="PostToolBatch") == "" and run(184_000) == "")

    shutil.rmtree(root, ignore_errors=True)
    print("\n%s" % ("all checks pass" if not bad else "%d checks FAILED" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(main())

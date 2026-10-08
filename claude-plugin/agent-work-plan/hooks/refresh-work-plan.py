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

Each mark asks once. Falling back below a mark that has asked is how a compaction is recognised: the marks reset, and the
next climb asks again. A mark that asked and was not answered - the plan not written since - is said again at the end of
every turn while the context stays above it, because the whole point is that the plan is current before the client
compacts.

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
import shlex
import sys
import time

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True

from plan_path import MAX_DETAIL_CHARS, MAX_DETAIL_LINES, latest_reply_matches, plan_file, settings

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

USAGE_KEYS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")

TAIL_START = 64 * 1024           # first window tried when reading back
TAIL_MAX = 1024 * 1024           # give up past this; the answer is not worth more

# How far the model identity is looked for. It is only looked for in the one band where it changes the outcome - between
# the first standard-window mark and STANDARD_WINDOW_CEILING - and these bound what that costs. The identity attachment
# lands in a session's first rows, and a session that switched models writes another where it switched, which can be
# megabytes from the end; a switch further back than the tail reached leaves the window undecided, and an undecided
# window gets the standard marks too. That costs one early request, which is cheap: the request is a command per row.
ATTACHMENT_HEAD = 1024 * 1024
ATTACHMENT_TAIL = 3 * 1024 * 1024
COST_STATE_MAX = 1024 * 1024

# The command that changes a row, given with its full path so it never has to be found.
ROW_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plan-row.py")


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


def tail_rows(path, window):
    """Transcript lines from the last `window` bytes, newest first."""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        fh.seek(max(0, size - window))
        chunk = fh.read().decode("utf-8", "replace")
    return list(reversed(chunk.split("\n")))


def head_rows(path, window):
    with open(path, "rb") as fh:
        return fh.read(window).decode("utf-8", "replace").split("\n")


def current_context(path):
    """Tokens sent on the main thread's most recent model call, or None.

    A sub-agent writes into the same transcript, and its context is a fraction of the main thread's; reading its usage as
    the session's would under-report by hundreds of thousands of tokens exactly when it matters.
    """
    window = TAIL_START
    while window <= TAIL_MAX:
        try:
            rows = tail_rows(path, window)
        except OSError:
            return None
        for line in rows:
            if '"usage"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("type") != "assistant" or row.get("isSidechain"):
                continue
            u = (row.get("message") or {}).get("usage")
            if isinstance(u, dict):
                return sum(u.get(k) or 0 for k in USAGE_KEYS)
        if window >= os.path.getsize(path):
            return None
        window *= 4
    return None


def pending_tool_bytes(path):
    """Bytes of tool results written but not yet sent to a model.

    A usage figure only counts what a model has already been given, so a batch whose results sit in the transcript adds
    nothing to it - and then all of it arrives at once. That is how a session goes from 109,603 to 487,753 tokens between
    two consecutive calls. Size is taken at one token per byte: pessimistic for English prose, about right for what causes
    the jump (digests and CJK tables), and over-estimating only asks slightly early.
    """
    window = TAIL_START
    while window <= TAIL_MAX:
        try:
            rows = tail_rows(path, window)
            size = os.path.getsize(path)
        except OSError:
            return 0
        total = 0
        for line in rows:
            if '"usage"' in line:
                try:
                    row = json.loads(line)
                except ValueError:
                    row = None
                if (isinstance(row, dict) and row.get("type") == "assistant" and not row.get("isSidechain")
                        and isinstance((row.get("message") or {}).get("usage"), dict)):
                    return total
            if '"tool_result"' in line:
                total += len(line.encode("utf-8", "replace"))
        if window >= size:
            return total
        window *= 4
    return 0


def latest_bare_model(path):
    """The model on the most recent assistant message: the bare name, without the [1m] suffix, but certainly current."""
    window = TAIL_START
    while window <= TAIL_MAX:
        try:
            rows = tail_rows(path, window)
            size = os.path.getsize(path)
        except OSError:
            return None
        for line in rows:
            if '"model"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("type") != "assistant":
                continue
            m = (row.get("message") or {}).get("model")
            if m and not m.startswith("<"):
                return m
        if window >= size:
            return None
        window *= 4
    return None


def decide_variant(bare, candidates):
    """Whether `candidates` say `bare` runs as a 1M variant; None when none of them refers to it.

    A candidate can carry a Bedrock cross-region prefix (global.anthropic.claude-opus-4-8[1m]) while the bare name never
    does. Model names contain no dot, so keeping what follows the last one normalises the prefixed form.
    """
    matching = [c for c in candidates if c.rsplit(".", 1)[-1] in (bare, bare + "[1m]")]
    if not matching:
        return None
    return all(c.endswith("[1m]") for c in matching)


def model_attachments(path):
    """Every modelId the transcript's model-identity attachments carry, from its head and its tail."""
    found = []
    for reader, window in ((head_rows, ATTACHMENT_HEAD), (tail_rows, ATTACHMENT_TAIL)):
        try:
            rows = reader(path, window)
        except OSError:
            continue
        for line in rows:
            if '"marketingName"' not in line and '"type":"model"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            att = row.get("attachment")
            if not isinstance(att, dict) or att.get("type") != "model":
                continue
            mid = (att.get("identity") or {}).get("modelId")
            if mid and mid not in found:
                found.append(mid)
    return found


def on_1m_window(path):
    """True on a 1M-context model, False on a standard one, None if it cannot be told.

    The transcript keeps the suffix that decides the window in two places: the model-identity attachment, near the start
    and wherever the model was switched, and the cost-state rows, which exist only once cost is accounted. Both are
    checked against the bare name on the latest reply, so an identity left over from before a switch decides nothing.
    Uncertainty resolves towards the standard window: a standard session given only the 1M marks could never reach any of
    them, would never be asked, and would show no sign of having failed.
    """
    bare = latest_bare_model(path)
    if not bare:
        return None
    verdict = decide_variant(bare, model_attachments(path))
    if verdict is not None:
        return verdict
    window = TAIL_START
    while window <= COST_STATE_MAX:
        try:
            rows = tail_rows(path, window)
            size = os.path.getsize(path)
        except OSError:
            return None
        for line in rows:
            if '"modelUsage"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            mu = row.get("modelUsage")
            if isinstance(mu, dict) and mu:
                return decide_variant(bare, list(mu))
        if window >= size:
            return None
        window *= 4
    return None


def state_path(plan):
    """Beside the plan, like the other marks the hooks leave, and swept with it when the conversation is gone."""
    return os.path.splitext(plan)[0] + ".watermark"


def read_state(path):
    """Which marks have already asked, and when the last one asked. Anything unreadable is the empty state: the worst
    that costs is one extra request, while guessing at damaged input could suppress one."""
    empty = {"fired": set(), "asked_at": None}
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return empty
    m = re.search(r"^- fired:[ \t]*(.*)$", text, re.M)
    fired = {int(p) for p in (m.group(1).split(",") if m else []) if p.strip().isdigit()}
    asked = None
    m = re.search(r"^- asked-at:[ \t]*([0-9.]+)$", text, re.M)
    if m:
        try:
            asked = float(m.group(1))
        except ValueError:
            asked = None
    return {"fired": fired, "asked_at": asked}


def write_state(path, fired, asked_at=None, seen=None):
    body = (
        "# Water-mark state\n"
        "\n"
        "Written by the hook that watches this conversation's context size. `fired` are the marks that have already\n"
        "asked for the plan to be brought up to date, `asked-at` is when the most recent one asked, and `last-checked`\n"
        "is the last time the hook ran at all - its presence is how you tell it is wired up while it has nothing to say.\n"
        "The marks reset when a compaction brings the context back below one. Safe to delete.\n"
        "\n"
        "- fired: %s\n" % ", ".join(str(v) for v in sorted(fired))
        + ("- asked-at: %.3f\n" % asked_at if asked_at else "")
        + ("- last-checked: %s\n" % seen if seen else "")
    )
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


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
    command = "python3 %s %s" % (shlex.quote(ROW_TOOL), shlex.quote(plan))
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


def nag(mark, ctx, plan):
    return ("The context is %s tokens, past the %s mark, and the work plan has not been written since that mark was "
            "reached. An automatic compaction is a turn or two away, and what the `doing` rows do not say is left to a "
            "lossy summary when it lands. Update it now. " % (format(ctx, ","), format(mark, ","))
            + what_to_write(plan))


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
    transcript = payload.get("transcript_path")
    if not transcript or not os.path.isfile(transcript):
        return 0

    # stop_hook_active is deliberately not consulted. It marks the turn this hook's own request extended, and that turn
    # updates the plan and then carries on with the work it interrupted, which makes it the fastest climb of all. Nothing
    # can loop on it: a mark asks once, recorded on disk.

    ctx = current_context(transcript)
    if ctx is None:
        return 0
    pending = pending_tool_bytes(transcript)
    ctx_next = ctx + pending

    standard, one_m = marks_for()
    if ctx_next > STANDARD_WINDOW_CEILING:
        window_1m, label = True, "1M-by-size"
    elif ctx_next >= min(standard):
        window_1m = on_1m_window(transcript)
        label = {True: "1M", False: "standard", None: "unknown"}[window_1m]
    else:
        window_1m, label = None, "not-needed"
    marks = one_m if window_1m else standard + one_m

    path = state_path(plan)
    state = read_state(path)
    fired, asked_at = state["fired"], state["asked_at"]

    # Only marks currently in force count: a mark recorded under different settings stays in the file, and comparing
    # against one that no longer exists would keep a session from ever being asked again.
    live = fired & set(marks)
    if live and ctx_next < min(live):
        fired, asked_at = set(), None

    seen = "%s ctx=%d pending=%d window=%s event=%s" % (time.strftime("%Y-%m-%d %H:%M:%S"), ctx, pending, label, event)
    relaying = latest_reply_matches(transcript, limits["quietWhenReplyMatches"])

    due = [m for m in marks if ctx_next >= m and m not in fired]
    if due:
        # Recorded even while relaying: leaving the relay must not make a mark long passed speak.
        write_state(path, fired | set(due), None if relaying else time.time(), seen)
        if not relaying:
            mark = max(due)
            emit(event, message(mark, ctx_next, plan, mark in one_m))
        return 0
    write_state(path, fired, asked_at, seen)

    if event != "Stop" or relaying:
        return 0
    behind = [m for m in sorted(fired & set(marks), reverse=True) if ctx_next >= m]
    if not behind or plan_written_since(plan, asked_at):
        return 0
    emit(event, nag(behind[0], ctx_next, plan))
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

    def write_plan(stale):
        with open(plan, "w", encoding="utf-8") as fh:
            json.dump({"nodes": [{"title": "r", "state": "doing"}]}, fh)
        if stale:
            os.utime(plan, (1, 1))

    def write_transcript(ctx_tokens, relay=False, model=None, usage_keys=None, attachment_id=None,
                         sidechain_ctx=None, pending_bytes=0, switched_to=None, pad_bytes=0):
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
        rows.append({"type": "assistant", "message": {"content": [{"type": "text", "text": text}], "usage": {
            "input_tokens": 2, "cache_read_input_tokens": ctx_tokens - 2, "cache_creation_input_tokens": 0}}})
        if model:
            rows[-1]["message"]["model"] = model
        if sidechain_ctx is not None:
            rows.append({"type": "assistant", "isSidechain": True, "message": {
                "content": [{"type": "text", "text": "subagent"}],
                "usage": {"input_tokens": 1, "cache_read_input_tokens": sidechain_ctx - 1}}})
        with open(transcript, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
            if pending_bytes:
                fh.write(json.dumps({"type": "user", "message": {"content": [
                    {"type": "tool_result", "content": "x" * max(0, pending_bytes - 120)}]}}) + "\n")

    def run(ctx_tokens, reset=False, event="Stop", active=False, extra_env=None, **kw):
        if reset and os.path.exists(state):
            os.remove(state)
        write_transcript(ctx_tokens, **kw)
        p = {"hook_event_name": event, "session_id": sid, "transcript_path": transcript}
        if active:
            p["stop_hook_active"] = True
        r = subprocess.run(me, input=json.dumps(p), stdout=subprocess.PIPE, universal_newlines=True,
                           env=dict(env, **(extra_env or {})))
        return r.stdout.strip()

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
    check("  and again while it is still not written", "has not been written since" in said(run(196_600)))
    write_plan(stale=False)
    check("plan written -> silent", run(196_700) == "")

    # --- a compaction lands, and the climb back asks again ---
    check("after a compaction -> silent", run(6_000) == "")
    check("climbing back -> the first mark asks again", "170,000" in said(run(171_000)))

    # --- the 1M group ---
    c = said(run(961_000, reset=True))
    check("crossing 960k -> asks, and says a compaction is close", "960,000" in c and "compaction is close" in c)
    check("a turn extended by a request is still checked", "170,000" in said(run(171_000, reset=True, active=True)))

    # --- relaying for another model ---
    relay = r"^\s*\([A-Za-z0-9._-]+-through-[A-Za-z0-9._-]+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)"
    with open(os.path.join(data, "config.json"), "w") as fh:
        json.dump({"quietWhenReplyMatches": relay}, fh)
    check("a reply matching the quiet pattern -> silent", run(171_000, reset=True, relay=True) == "")
    check("  and the mark is used up rather than left to speak later", "- fired: 170000" in state_text()
          and "- asked-at:" not in state_text())
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
    check("model switched mid-session -> treated as standard", "180,000" in said(run(
        181_000, reset=True, model="claude-opus-5", usage_keys=["claude-opus-5", "claude-opus-5[1m]"])))
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

    # --- unconsumed tool results count ---
    check("120k + 30 KB pending is still under the mark -> silent", run(120_000, reset=True, pending_bytes=30_000) == "")
    check("150k + 40 KB pending crosses 180k -> asks",
          "180,000" in said(run(150_000, reset=True, pending_bytes=40_000)))

    # --- the in-turn event asks but never repeats itself ---
    write_plan(stale=True)
    out = run(181_000, reset=True, event="PostToolBatch")
    check("in-turn event asks too, under its own event name", "180,000" in said(out)
          and json.loads(out)["hookSpecificOutput"]["hookEventName"] == "PostToolBatch")
    check("  the in-turn event does not say it again", run(182_000, event="PostToolBatch") == "")
    check("  end of turn does, while the plan is unwritten", "has not been written since" in said(run(182_000)))
    write_plan(stale=False)
    check("plan written -> both events quiet", run(184_000, event="PostToolBatch") == "" and run(184_000) == "")

    check("a sub-agent's smaller context does not mask the session's",
          "180,000" in said(run(181_000, reset=True, sidechain_ctx=9_000)))

    shutil.rmtree(root, ignore_errors=True)
    print("\n%s" % ("all checks pass" if not bad else "%d checks FAILED" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(main())

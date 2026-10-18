#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Tell the model which time zone the user reads the panel in, when that is not this machine's.

With Remote SSH the model runs on one machine and the person reads on another, often hours apart. Every clock the model
can see is this machine's - `date`, file times, logs, the date Claude Code gives as today - while the panel shows times
in the reader's zone, so a model that reports "finished at 04:30" is right by a clock the reader never sees. Saying it
once is not enough: it scrolls out of attention over a long conversation and is summarised away by a compaction. So
this speaks on every message the user sends and again after a compaction, and says nothing when the two zones agree,
which keeps a window on its own machine at no cost at all.

The zone comes from the panel, by way of the extension (src/panel-tz.js reports it, extension.js leaves it in
ZONE_FILE). The hook has no zone database of its own - Python 3.9's zoneinfo is not there on every machine this runs
on - so it asks the C library, through TZ and the system's zone files, what the time is there.
"""
import json
import os
import re
import sys
import time

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True

from plan_path import data_dir, latest_reply_matches, settings

ZONE_FILE = "client-time-zone.json"
# An IANA name as Intl reports it. It becomes a path under the zone database, so nothing that could climb out of it.
ZONE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$")
ZONE_DIRS = ("/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/share/lib/zoneinfo")


def reported_zone(directory=None):
    try:
        with open(os.path.join(directory or data_dir(), ZONE_FILE), encoding="utf-8") as fh:
            given = json.load(fh)
    except Exception:
        return ""
    zone = given.get("timeZone") if isinstance(given, dict) else None
    return zone if isinstance(zone, str) and ZONE_NAME.match(zone) else ""


def clock_in(zone, now):
    """`now` as a local time in `zone`, or None when this machine cannot say.

    A name the C library does not find is read as UTC without complaint, so the zone file has to be there first: a wrong
    time stated with confidence is worse than none.
    """
    if not hasattr(time, "tzset") or not any(os.path.isfile(os.path.join(d, zone)) for d in ZONE_DIRS):
        return None
    saved = os.environ.get("TZ")
    try:
        os.environ["TZ"] = zone
        time.tzset()
        return time.localtime(now)
    finally:
        if saved is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = saved
        time.tzset()


def offset(seconds):
    sign = "-" if seconds < 0 else "+"
    seconds = abs(int(seconds))
    return "UTC%s%02d:%02d" % (sign, seconds // 3600, seconds % 3600 // 60)


def named(t):
    """The zone's abbreviation and offset, leaving out an abbreviation that is only the offset again ("+04")."""
    abbr = getattr(t, "tm_zone", "") or ""
    return "%s, %s" % (abbr, offset(t.tm_gmtoff)) if abbr[:1].isalpha() else offset(t.tm_gmtoff)


def describe(zone, now):
    """What to tell the model about `zone` at `now`; empty when there is nothing to tell."""
    theirs = clock_in(zone, now) if zone else None
    if theirs is None:
        return ""
    ours = time.localtime(now)
    if theirs.tm_gmtoff == ours.tm_gmtoff:
        return ""
    return ("The user is in %s (%s), where it is now %s. This machine runs on %s (%s): `date`, file times and log "
            "lines here are in that zone, and so is the date Claude Code gives as today. Say times and dates to the "
            "user in their zone, converting any you read here."
            % (zone, named(theirs), time.strftime("%a %Y-%m-%d %H:%M", theirs),
               getattr(ours, "tm_zone", "") or "local time", offset(ours.tm_gmtoff)))


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict) or not settings()["tellTimeZone"]:
        return 0
    event = payload.get("hook_event_name", "UserPromptSubmit")
    # After a compaction this is one more instruction in a conversation that may be relaying another model word for
    # word, which is what the quiet pattern is for (see plan_path.py).
    transcript = payload.get("transcript_path")
    if event == "SessionStart" and isinstance(transcript, str) and transcript \
            and latest_reply_matches(transcript, settings()["quietWhenReplyMatches"]):
        return 0
    text = describe(reported_zone(), time.time())
    if not text:
        return 0
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))
    return 0


def selftest():
    import shutil
    import tempfile

    failures = []

    def check(label, cond):
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            failures.append(label)

    # 2026-10-18 16:41 UTC: summer time in Los Angeles.
    summer = 1792341660
    # 2026-12-18 16:41 UTC: winter time there.
    winter = summer + 61 * 86400
    os.environ["TZ"] = "UTC"
    time.tzset()
    said = describe("America/Los_Angeles", summer)
    check("another zone is described with its offset and local time",
          "America/Los_Angeles (PDT, UTC-07:00)" in said and "Sun 2026-10-18 09:41" in said)
    check("and the machine's zone is named", "This machine runs on UTC (UTC+00:00)" in said)
    check("the offset follows the date", "(PST, UTC-08:00)" in describe("America/Los_Angeles", winter))
    check("half hours are kept", "UTC+05:30" in describe("Asia/Kolkata", summer))
    check("an abbreviation that only repeats the offset is left out", "(UTC+04:00)" in describe("Asia/Dubai", summer))
    check("the same offset under another name says nothing", describe("Etc/UTC", summer) == "")
    check("a name the machine has no zone file for says nothing", describe("Mars/Olympus_Mons", summer) == "")
    check("no zone says nothing", describe("", summer) == "")
    os.environ["TZ"] = "America/Los_Angeles"
    time.tzset()
    check("a machine in the user's own zone says nothing", describe("America/Los_Angeles", summer) == "")
    check("and the machine's TZ is put back afterwards", os.environ.get("TZ") == "America/Los_Angeles"
          and time.localtime(summer).tm_hour == 9)

    tmp = tempfile.mkdtemp()
    try:
        def write(value):
            with open(os.path.join(tmp, ZONE_FILE), "w", encoding="utf-8") as fh:
                fh.write(value)
        check("no file reads as no zone", reported_zone(tmp) == "")
        write(json.dumps({"timeZone": "Asia/Tokyo"}))
        check("the reported zone is read", reported_zone(tmp) == "Asia/Tokyo")
        write(json.dumps({"timeZone": "../../etc/passwd"}))
        check("a name that climbs out of the zone database is refused", reported_zone(tmp) == "")
        write("{")
        check("a half-written file reads as no zone", reported_zone(tmp) == "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("%d checks failed" % len(failures))
        return 1
    print("all checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if sys.argv[1:2] == ["--selftest"] else main())

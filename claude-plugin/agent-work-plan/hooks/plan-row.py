#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Change the state of one row of a work plan, or add a row: the state, the note, and the times that go with them.

  plan-row.py PLAN set ROW STATE [--note TEXT]
  plan-row.py PLAN add STATE TITLE [--under ROW] [--note TEXT]

ROW is the number shown in front of a row, closed rows counted: 3 is the third row at the top, 2.1 the first one under
the second. Not a hook - the model runs it, and the injected block gives its full path every turn.

It exists because a change of state is one simple action and was being paid for as a large one. Done by hand it means
reading the whole file, changing one field and writing all of it back - of 884 writes to plans measured on the machine
this was written on, 643 went through the shell, mostly as a script composed for the occasion - and reading the clock
first, which is the step that gets skipped or invented. A cost like that is a reason to save every change for one write
at the end of the turn, and `doing` is the one state that cannot wait that long.

Which row, and which state, is decided by whoever runs it; nothing here judges what the work is. The file is read
immediately before it is written, so a correction the user made by hand a moment ago is kept rather than reverted.
"""
import argparse
import json
import os
import re
import sys

# Set before the import below: see inject-work-plan.py.
sys.dont_write_bytecode = True

from plan_path import CLOSED_STATES, STATES, now_stamp, settings

PLAN_NAME = re.compile(r"^[0-9A-Fa-f][0-9A-Fa-f-]{7,}\.json$")


class Refused(Exception):
    pass


def find(nodes, number):
    """The row a number names, counted the way the injected block and the tree count it, or None."""
    node, level = None, nodes
    for part in str(number).split("."):
        if not part.isdigit() or int(part) < 1:
            return None
        i = int(part) - 1
        if not isinstance(level, list) or i >= len(level) or not isinstance(level[i], dict):
            return None
        node = level[i]
        level = node.get("children")
    return node


def enter(node, state, now):
    """Put a row in a state, with the times that belong to it.

    `since` says when the row entered the state it is in, which is how long a `doing` or a `waiting` row has been one.
    `closed` belongs to the two closed states only: a row reopened keeps nothing claiming it had ended.
    """
    node["state"] = state
    node["since"] = now
    if state in CLOSED_STATES:
        node["closed"] = now
    else:
        node.pop("closed", None)


def note(node, text):
    if text is None:
        return
    if text.strip():
        node["note"] = text.strip()
    else:
        node.pop("note", None)


def load(path, may_create):
    try:
        with open(path, encoding="utf-8") as fh:
            body = fh.read()
    except FileNotFoundError:
        if may_create:
            return {"nodes": []}
        raise Refused("There is no plan at %s yet. Adding a row starts one." % path)
    try:
        plan = json.loads(body)
    except ValueError as e:
        raise Refused("The plan at %s does not parse (%s). Fix it by hand rather than through this." % (path, e))
    if not isinstance(plan, dict) or not isinstance(plan.get("nodes"), list):
        raise Refused("%s has no list of rows in it, so it is not a work plan." % path)
    return plan


def save(path, plan):
    """Write the whole file and rename it into place, so the tree never reads half of one."""
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(plan, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass
        raise


def run(args):
    path = os.path.abspath(args.plan)
    if not PLAN_NAME.match(os.path.basename(path)):
        raise Refused("%s is not a work plan: a plan is named by its conversation's session id." % path)
    if not settings(os.path.dirname(path))["enabled"]:
        raise Refused("Work plans are switched off for this editor (claudeCodeExtras.workPlan), so nothing reads this "
                      "file. Track what is left in your reply instead.")
    plan = load(path, args.action == "add")
    now = now_stamp()
    if args.action == "set":
        node = find(plan["nodes"], args.row)
        if node is None:
            raise Refused("There is no row %s in this plan." % args.row)
        was = node.get("state", "todo")
        enter(node, args.state, now)
        note(node, args.note)
        said = "row %s: %s -> %s" % (args.row, was, args.state)
    else:
        title = args.title.strip()
        if not title:
            raise Refused("A row needs a title.")
        if args.under:
            parent = find(plan["nodes"], args.under)
            if parent is None:
                raise Refused("There is no row %s to add this under." % args.under)
            if not isinstance(parent.get("children"), list):
                parent["children"] = []
            siblings, prefix = parent["children"], args.under + "."
        else:
            siblings, prefix = plan["nodes"], ""
        node = {"title": title, "state": args.state}
        note(node, args.note)
        node["opened"] = now
        enter(node, args.state, now)
        node["children"] = []
        siblings.append(node)
        said = "row %s%d added: %s" % (prefix, len(siblings), args.state)
    save(path, plan)
    return said


def main(argv=None):
    parser = argparse.ArgumentParser(prog="plan-row.py", description="Change the state of one row of a work plan, "
                                     "or add a row. The times are read from the clock.")
    parser.add_argument("plan", help="the plan file, as given at the top of the injected block")
    actions = parser.add_subparsers(dest="action")
    actions.required = True
    change = actions.add_parser("set", help="put a row in a state")
    change.add_argument("row", help="the number shown in front of the row, such as 3 or 2.1")
    change.add_argument("state", choices=STATES)
    change.add_argument("--note", help="replace the row's note; an empty one removes it")
    add = actions.add_parser("add", help="add a row, at the end of the plan or under another row")
    add.add_argument("state", choices=STATES)
    add.add_argument("title")
    add.add_argument("--under", metavar="ROW", help="the row to add it under")
    add.add_argument("--note")
    args = parser.parse_args(argv)
    try:
        print(run(args))
    except Refused as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

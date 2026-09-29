# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Where this conversation keeps its work plan.

Shared by both hooks rather than written twice: one of them reads the file and the other watches its timestamp, so two
copies of this that drifted apart would leave the nudge watching a path nobody writes - and nothing would say so.
"""
import os
import sys

# The platform gives every plugin a data directory named <plugin>-<marketplace>, and hooks.json passes ours in as
# ${CLAUDE_PLUGIN_DATA}. This is that same name spelled out, for the case where the expansion did not happen. It is
# also the one directory the VS Code extension reads, so falling back to it keeps the two halves looking at one place.
FALLBACK = os.path.join(os.path.expanduser("~"), ".claude", "plugins", "data", "agent-work-plan-claude-code-extras")


def data_dir():
    given = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CLAUDE_PLUGIN_DATA", "")
    # An unexpanded placeholder arrives as its own literal text, which would otherwise become a directory of that name.
    if given and "$" not in given and os.path.isabs(given):
        return given
    return FALLBACK


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

# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Whether a tool call changed something, as against looking at something.

Both reminders ask it - the one at the end of a turn, about the whole turn, and the one when a turn starts working,
about each batch of calls - so it is written once. Two copies of a judgement this delicate would be tuned apart one false
alarm at a time, and the two reminders would then disagree about the same call with nothing saying which was right.
"""
import re

# Tools that change something by definition. Everything not named here - reading, searching, fetching, measuring - is a
# turn looking at the world rather than altering it, and owes the plan nothing.
CHANGING_TOOLS = ("Write", "Edit", "NotebookEdit")
# A shell command that changes something. Bash cannot be judged by its name, so it is judged by what it runs, and the
# uncertain cases are resolved towards silence: a command this misses makes a reminder miss a turn, while a command it
# wrongly catches puts the reminder back on the turns it was just taken off.
#
# The redirection branch is the delicate one, because `>` is a redirect in a shell and a comparison everywhere else, and
# a heredoc script is passed as one argument so both meanings turn up in the same string. It therefore excludes `2>&1`
# and `>/dev/null`, which appear in commands that only read, and `>=` and `=>`, which are not redirects at all - a
# `count >= 4` inside an embedded script read as a write and put the reminder back on turns that had changed nothing.
CHANGING_SHELL = re.compile(
    r"\bgit\s+(commit|add|push|mv|rm|apply|checkout|reset|revert|tag|stash)\b"
    r"|\b(tee|mkdir|rmdir|touch|mv|cp|rm|chmod|chown|ln|truncate|install)\s"
    r"|\bsed\s+-i"
    r"|(?<![>=])>>?\s*(?!/dev/)[^&=\s|]"
    r"|\bopen\([^)]*['\"][wa]"
)


def changes(name, tool_input):
    """True when a call of this tool with this input altered something."""
    if name in CHANGING_TOOLS:
        return True
    if name == "Bash" and isinstance(tool_input, dict):
        command = tool_input.get("command")
        return isinstance(command, str) and bool(CHANGING_SHELL.search(command))
    return False

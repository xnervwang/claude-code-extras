---
name: maintain
description: Keep this conversation's work plan up to date - the tree of what it still has to do, with a state on every row. Use it when the user raises something new to be done, when they approve something, when a piece of work is finished or abandoned, and when doing one thing turns out to require finishing another first. Also use it before ending a turn that changed the shape of the work, which is what the Stop hook asks for.
version: 1.0.0
tags: [work-plan, task-tracking, long-conversation, handoff]
---

# Maintain this conversation's work plan

A long conversation branches. Something is raised, it turns out to need something else first, that opens a third
question, and by the time the third is answered the main line is out of sight. The plan is the record of that stack: one
file per conversation, holding what is still to do and where each thing sits.

It is not a summary and not a design document. Every row is a piece of work. A constraint, an exclusion, a decision or a
piece of reasoning is not a piece of work and does not belong here - it goes wherever that conversation keeps such
things.

## Where the file is

Once a plan exists, its full path arrives at the start of every turn, in the same block as the open rows. Use that one.

Before one exists nothing is injected at all, so for the first row the path has to be built:

```bash
echo "$HOME/.claude/plugins/data/agent-work-plan-claude-code-extras/$CLAUDE_CODE_SESSION_ID.json"
```

One file per conversation, named by its session id, in the directory the platform gives this plugin. That directory's
name comes from the plugin and the marketplace it was installed from, so if the injected path ever disagrees with what
the command prints, **the injected one is right** - it came from the platform rather than from this document.

A conversation joins in wherever it happens to be: an existing one that has never had a plan simply starts with an empty
one, and nothing is reconstructed from what was said before. Start the file when there is something to put in it, not
before. A conversation that is one question and one answer does not need a plan, and an empty one is noise on every turn
that follows.

## The number in front of a row

Every injected row carries one - `1`, `2`, then `2.1` and `2.1.1` beneath it - and the tree view shows the same numbers.
It is how someone names a row out loud instead of quoting its title, so `close 3` and `put 2.1 back to todo` are ordinary
instructions and mean a specific row.

**The number is not in the file, and it does not have to be looked up.** Every open row arrives with its own number in
front of it at the start of the turn, so the number and the row reach you together and there is nothing to work out. That
covers the rows anyone is likely to name, since those are the ones they can see.

For a row that is not in that block - a closed one - the number is an index into the file and resolving it is arithmetic
rather than a search: `3` is `nodes[2]`, and `2.1.1` is `nodes[1].children[0].children[0]`. Never search the file for the
digits; they are not written in it.

**Closed rows are counted.** They are skipped when the open rows are drawn, so the fifth row you were handed this turn is
not row 5 - it might be row 44. Counting what you can see is the one mistake here that silently closes the wrong task.
That is also what makes a number worth quoting: finishing something leaves a gap rather than moving every number after
it, so a number said an hour ago still points where it pointed then.

Do not write numbers into a title. A number stored in the text stops agreeing with the position it claims the moment
anything is inserted, and then the file contradicts itself.

## The file

```json
{
  "title": "what this conversation is about",
  "nodes": [
    {
      "title": "one piece of work, in a line",
      "state": "discussing",
      "note": "optional: a commit, why it is parked, who asked",
      "detail": "optional: several lines. What the row cannot say in its width - the user's own words, what was\nalready established, what to watch out for when this is picked up.",
      "opened": "2026-09-28T23:45:12+00:00",
      "closed": "2026-09-29T01:10:03+00:00",
      "children": []
    }
  ]
}
```

**`detail` is limited to 12 lines and 900 characters, and the view cuts it there.** Past that it says the description is
too long, on the row, where it is read.

That limit is not about the dialog's size. A description is what the next person needs in order to pick the task up: the
user's own words, what is already settled, the trap to avoid. It is not the story of how the task got here. Given room,
that story is what gets written - every turn adds the reasoning of that turn, and a plan of chronicles is a plan nobody
reads, which costs the plan the one thing it is for. So there is no roomier view to escape into, on purpose.

Where the rest belongs: reasoning in the commit message, a rule that came out of it in that rule, a measurement in
whatever document owns the thing measured.

`title` and `state` are required on a node; the rest may be left out.

**Write `title`, `note` and `detail` in the language the conversation is being held in.** The criterion is who chooses
the words: anything written as the conversation goes is written in its language, because the reader of the plan is the
reader of the conversation. Only text fixed in a shipped file has to be English — that file goes to people whose
conversations are in languages of their own, and no one can switch it per reader. So the `state` keywords below stay as
they are, and so does every word the extension and these hooks draw for themselves.

The five `state` values are fixed keywords and are always these:

| `state` | what it means |
|---|---|
| `discussing` | raised, not yet agreed to be done |
| `todo` | agreed, not started or not finished |
| `parked` | deliberately not being done now, with the reason in `note` |
| `done` | finished |
| `dropped` | decided against, with the reason in `detail` |

## The two times

`opened` goes on a row when you add it. `closed` goes on when you move it to `done` or `dropped`, and only then - a
`parked` row is still open and has no end yet.

**Read the clock; never write a time from memory.** You do not know what time it is. A value you invent looks exactly
like a real one in the file and is only discovered when the rows sort into the wrong order:

```bash
date -Is
```

Both fields are optional, and a row that has neither is fine - it simply shows no time. **Do not fill them in for rows
that predate them.** The date in an old row's `note` has no clock in it, so any time you supply for one is invented, and
the whole point of these fields is that they can be trusted.

Keep dates out of `note` from now on - that is what these fields are for, and a row carrying both shows the same day
twice. `note` is for what the time cannot say: a commit, who asked for it, why it is parked.

**A child is something that has to be finished before its parent can be.** That is the only thing nesting means. It
does not mean "came up while discussing", it does not mean "is related to", and it does not mean "is a sub-topic of".
Getting this wrong turns the plan into a transcript of the conversation's wandering, which is the thing it exists to
undo.

## When to write to it

| What just happened | What to do |
|---|---|
| The user raises something new to be done | Add a node with state `discussing` and an `opened` time |
| The user says to go ahead with it | Move that node to `todo` |
| The work is finished, or the user says it is | Move it to `done` and set `closed` |
| The user decides against it | Move it to `dropped` and set `closed`, with the reason in `detail` |
| Doing A turns out to need B finished first | Add B as a child of A, with its own `opened` |
| The user says to leave something for later | Move it to `parked`, with the reason in `note` |

**Only the user's word moves a row to `todo`.** Anything you decide is worth doing goes in as `discussing` and stays
there until they agree. The plan is the user's picture of what is coming, so a row saying `todo` has to mean they said
so - otherwise reading it tells them what you intend rather than what was agreed, and they lose the one thing it was
for.

**Do this before writing the last paragraph of the turn**, not after. Once the closing summary is written the turn feels
finished and the plan is what gets left out; and the turn that most needed recording is the one that wandered furthest,
which is exactly the turn with the longest summary to write.

## Two rules that do not bend

**Read the file before writing it.** Write the whole file at once, from what you just read - never from what you
remember of it. The user edits this file by hand to correct you, and that is the point of it; a write built from memory
silently reverts their correction, and nothing anywhere will say that it happened.

**Only change states. Never delete a node.** A finished piece of work becomes `done` and stays visible; something
decided against becomes `dropped` and stays visible with its reason. Deleting is how the plan loses the record of what
was already settled, and then the same question gets reopened weeks later with nobody able to say what was decided or
why. A closed row whose children are still open stays legible too, because that is the row that says where to return
to.

## What it costs to read

Only the open rows are put in front of you each turn, with a count of the closed ones. So a plan can hold the whole
history of a long conversation without the history being paid for on every turn - which is why closing a row is cheap
and deleting it is never necessary.

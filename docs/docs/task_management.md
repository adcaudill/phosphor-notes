---
title: Task Management
layout: page
---

# Task Management

Tasks in Phosphor are their own records, not lines of text. You write them in plain language, link them from any note, and manage them in the Tasks tab - with due dates, repeats, priorities, projects, tags, checklists, notes and comments.

## Creating a task

You never need to remember any syntax. Type the task the way you'd say it:

```
Pay rent on the first of each month !high #bills +Home
```

As you type, Phosphor highlights what it recognized and shows a preview - here: *Pay rent · Tue · Monthly on the 1st · High priority · bills · Home*. Press **Enter** to create it, or **Esc** to cancel.

There are three ways in:

- **`/task` in a note** - creates the task and inserts a link to it where you typed.
- **⌘⇧T (File › New Task…)** - in the editor, a task at the cursor. Anywhere else, a quick-capture box.
- **New task (N)** in the Tasks tab - in the Today view, new tasks are due today unless you say otherwise.

### What you can type

| You type | It means |
|---|---|
| `fri`, `on sat`, `by friday`, `due dec 4`, `tomorrow`, `in 3 days`, `next monday`, `in may`, `4/12` | Due date |
| `tomorrow at 3pm`, `fri at 9:30am` | Due date and time |
| `start mon`, `from dec 7` | Start date - the task stays out of Today until then |
| `daily`, `every 2 days`, `weekly on mon`, `every mon and thu`, `every weekday`, `every other tuesday` | Repeats |
| `on the first of each month`, `the 15th of each month`, `the last day of the month` | Monthly repeats |
| `the first monday of each month`, `the last friday of the month` | Monthly by weekday |
| `every year on mar 3` | Yearly |
| `every 3 days after done` | Repeats counted from when you complete it |
| `until jun 30`, `10 times` | When a repeat ends |
| `!high`, `!med`, `!low` (or `!!!`, `!!`, `!`) | Priority |
| `#bills` | Tag |
| `+Home`, `+"Project X"` | Project |
| `waiting on Bob` | Status Waiting, waiting on Bob |

Everything else is the title. Words that are usually just words don't count as dates on their own - "March on", "Enjoy the sun" and "Read chapter 3" stay as titles. To keep a phrase as part of the title, put it in quotes (`"every monday" newsletter`), or press **⌘⌫** to turn the last recognized piece back into text.

Numeric dates follow your system's date format (`4/12` is April 12 in the US, 4 December in the UK).

## Tasks in notes

A task in a note is a link, shown as the live task:

```
- Weekly sync
    - ☐ Send the summary   Fri   High priority
```

- **The checkbox** completes the task (or reopens it). A repeating task moves to its next date.
- **The title** opens the task's details. **⌘↵** with the cursor on that line does the same.
- **Pills** show the due date, repeat and priority. Overdue dates are red.

A task isn't tied to the note it was created in: the same task can be linked from several notes, or from none. Deleting a link only removes the link - never the task. If a task is deleted, its links show *Missing task*.

In the file, a link looks like `[[_task:k3f9a2xq|Send the summary]]`. When you rename a task, Phosphor updates the title in its links.

## Task details

Opening a task shows everything about it:

- **Status** - To do, Doing, Waiting, Done or Cancelled (keys `1`-`5`).
- **Due, Start, Repeat** - type them the same plain way (`next fri`, `every 2 weeks`). Each shows how it was read before saving. Clear a field to remove it.
- **Priority, Project, Tags, Waiting on.**
- **Checklist** - steps you tick off. Press Enter to add the next one, Backspace on an empty step to remove it, and ⌘↑/↓ to reorder.
- **Notes** - Markdown, with `[[links]]`.
- **Activity** - completions, status changes and comments, newest first. Add a comment with ⌘↵.
- **Mentioned in** - every note that links to the task. Click one to open it.
- **Copy link, Duplicate, Delete** - a deleted task can be restored from history.

Keys: **D**, **S**, **R**, **J** and **T** jump to Due, Start, Repeat, Project and Tags; **Esc** closes.

## Repeating tasks

- **On a schedule** (`monthly on the 1st`): completing it - early or late - moves it to the next date the schedule allows. If you complete it late, it skips ahead past today, so it never comes back already overdue.
- **After done** (`every 3 days after done`): the next date is counted from the day you complete it.
- **Month ends** stay at the month end: a task due on the 31st falls on Feb 28, then Mar 31.
- **Skip this one** moves to the next occurrence without completing it.
- The task's activity keeps every completion, so one task carries its whole history.
- A start date moves with the due date, and the checklist resets for each occurrence.

## The Tasks tab

| View | Shows |
|---|---|
| Inbox | Open tasks with no date or project yet |
| Today | Due today, overdue, or starting today |
| Upcoming | The next 14 days, by day |
| Anytime | Open tasks with no due date |
| Waiting | Tasks waiting on someone |
| Scheduled | Tasks that start later |
| Logbook | Done and cancelled, by completion day |
| All | Everything |

Below these, the list has a view for each **project** and each **tag** that has open tasks, and your **saved views**. A task added in a project or tag view gets that project or tag.

Group by due date, project, priority, status or tag, and sort by due date, priority, newest, recently changed, title, or **Manual**. Select a task to see its details beside the list.

### Calendar strip

Today and Upcoming show the next two weeks across the top, with how many tasks are due each day (and how many are overdue). Click a day to see just its tasks - a task added then is due that day. Drag tasks onto a day to reschedule them; a task's time of day is kept.

### Changing several tasks at once

⌘-click tasks to pick them, ⇧-click to pick a range, or press **X** on the selected task. A bar appears to complete them, set their due date (`fri`, `dec 4`, or `none`), priority, status or project, add a tag, or delete them. Space completes every picked task; Esc clears the picks.

### Manual order

Choose **Sort › Manual**, then drag tasks into the order you want, or move the selected task with **⌥↑** / **⌥↓**. Tasks are ordered within their group; tasks you haven't ordered come after the ordered ones, by due date.

### Saved views

Type a search, then click **Save** to keep it as a view in the list, with its grouping and sorting. Saved in a project or tag view, it stays limited to that project or tag. Changing a saved view's grouping or sorting updates it; hover over it in the list to delete it. Saved views are stored in your vault (`_tasks/.views.json`), so they move with it.

### Search and filters

Type in the search box to search every task's title, notes, checklist and comments. Add filters to narrow it down:

| Filter | Example |
|---|---|
| Status | `status:waiting`, `status:open` |
| Priority | `priority:high`, `priority:none` |
| Due date | `due:today`, `due:overdue`, `due:<7d`, `due:>2026-12-01`, `due:none` |
| Start date | `start:>today` |
| Completed | `completed:today`, `completed:week`, `completed:last-week`, `completed:month` |
| Tag, project | `#bills`, `+Home`, `+"Project X"` |
| Has | `has:notes`, `has:checklist`, `has:comments` |
| Repeats, links | `repeat:yes`, `linked:no` |
| Linked from a note | `in:"Weekly Review"` |

For example, `#bills due:<7d` finds bills due within a week.

### Keyboard

| Key | Action |
|---|---|
| J / K or ↓ / ↑ | Move through the list |
| Space | Complete or reopen |
| Enter | Open the task |
| E | Edit the title |
| D / S / R / T | Edit due, start, repeat, tags |
| X | Pick the task (for changing several at once) |
| ⌥↑ / ⌥↓ | Move the task (Manual sorting) |
| N | New task |
| / | Search |
| G then I, T, U, A, W, S, L, C | Go to Inbox, Today, Upcoming, Anytime, Waiting, Scheduled, Logbook, Checklist items |
| ? | Show the shortcuts |

## Today in your daily note

When you open today's daily note, a box at the top lists tasks that are overdue or due today. Tick one to complete it, or click it to open its details. The Tasks button in the sidebar shows the same count.

## Checklist items

A plain checkbox in a note - `- [ ] buy milk` - is a checklist item: quick, with no dates, and it stays part of the note. Tick it in place. The Tasks tab lists them under **Checklist items**.

To turn one into a task, put the cursor on it and click the **Convert to task** marker beside it (or press ⌘⇧T).

## Converting older tasks

Notes written before task files may have checkbox tasks carrying dates or repeats - `📅 2026-12-01`, `🔁 +1w`, `🔺`, `@due(...)`, `DEADLINE: <...>`. These show as plain text now. To convert them:

- **All notes:** Tasks tab › Checklist items › **Preview & convert…**
- **One note:** type `/convert-tasks` in it.

You see what will change before anything is written. Each line becomes a link to its new task, with its dates, repeat and priority. Completed copies of a repeating task (from the old way repeats worked) are folded into the task's history. Plain checkboxes are left alone. Every changed note can be restored from its history.

Logseq imports convert their tasks this way automatically, including `SCHEDULED`/`DEADLINE` dates and repeaters.

## Where tasks are stored

Each task is a Markdown file in your vault's `_tasks/` folder, with its details in the frontmatter and its notes below:

```markdown
---
id: k3f9a2xq
title: Pay rent
status: todo
priority: high
due: 2026-12-01
repeat:
  rule: FREQ=MONTHLY;BYMONTHDAY=1
  from: due
tags: [ bills ]
---
The account details are in [[Home/Lease]].
```

- Every change is saved to history, like notes.
- Task files are encrypted when your vault is.
- Task files don't appear in the sidebar; they're managed in the Tasks tab.
- A file that can't be read (for example, after a bad manual edit) is listed under **Problems** in the Tasks tab, and is never overwritten.

## AI apps

With AI access turned on, apps connected over MCP can list, search, create, complete and update tasks - see [the MCP server notes](technical_notes/mcp-server.md). Changing tasks has its own switch in Settings › AI Access: **Allow changes to tasks**.

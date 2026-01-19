# Task Management

This guide explains how to create and manage tasks in Phosphor. It describes the markdown syntax the editor recognizes, how to set due dates and recurrence, how tasks behave when completed, and how to use the Tasks panel.

## Basic task syntax

- Create a task using GitHub Flavored Markdown (GFM) checkbox bullets:

- [ ] Buy groceries

Status characters used by the app:

- `○` — todo (empty checkbox, stored as `[ ]`)
- `◐` — doing (in-progress, stored as `[/]`)
- `✓` — done (completed, stored as `[x]`)

You can toggle a task's status by:

- Clicking the checkbox indicator at the start of the line.
- Using the keyboard shortcut: `Mod+Enter` (Cmd+Enter on macOS) when the cursor is on the task line.

Notes about toggling:

- Click/clicking the indicator cycles `todo → doing → done → todo`.
- Keyboard `Mod+Enter` also cycles but behaves slightly differently for timestamps (see "Completion timestamps").

## Completion timestamps

When a task is marked done the app may add a completion timestamp appended to the line in this format:

`✓ 2026-01-12 14:30:45`

- If you click the checkbox to complete a task (or complete a recurring task via the indicator), the editor will add the completion timestamp automatically.
- Toggling a completed task back to todo removes the timestamp.
- The keyboard `Mod+Enter` toggle updates the checkbox state but does not always add the completion timestamp in the same way the click handler does.

## Due dates

You can add a due date using any of the supported forms. The editor will parse these and show them in the Tasks panel.

Supported due date forms (examples):

- Emoji style: `📅 2026-01-15`
- Phosphor style: `@due(2026-01-15)`
- Org-mode style (deadline): `DEADLINE: <2026-01-15>`

Example:

- [ ] File tax return 📅 2026-04-15

The Tasks panel categorizes due dates as:

- `🔴 Overdue` — date before today
- `🟠 Today` — date is today
- `🔵 Upcoming` — date after today
- `⚪ No Date` — no parsed due date

## Scheduled vs Due

- The parser supports Org-mode `SCHEDULED: <YYYY-MM-DD>` as a scheduled date (separate from `DEADLINE`/due date). The Tasks panel primarily uses the parsed `due`/`deadline` value for urgency.

## Recurring tasks

You can make a task recurring by adding recurrence metadata. Supported styles:

- Phosphor style: `@repeat(1w)` (one week)
- Emoji style: `🔁 +1w`

Recurrence format notes:

- Recurrence is expressed as an interval: `+<n><unit>` where unit can be `d` (days), `w` (weeks), `m` (months), `y` (years).
- Example units: `+1d`, `+2w`, `+1m`, `+1y`.

Example recurring task:

- [ ] Water plants 📅 2026-01-20 🔁 +1w

What happens when you complete a recurring task:

- Completing the current occurrence marks the current line as done and appends a completion timestamp.
- The editor inserts a new occurrence immediately below with the due date advanced by the recurrence interval and the checkbox reset to `[ ]` (todo).

Example before completion:

- [ ] Water plants 📅 2026-01-20 🔁 +1w

After completing (click the checkbox):

- [x] Water plants 📅 2026-01-20 🔁 +1w ✓ 2026-01-20 09:00:00
- [ ] Water plants 📅 2026-01-27 🔁 +1w

Notes:

- The inserted next occurrence keeps the same line text (metadata and recurrence) but advances the date.
- Completion via the checkbox click handler adds the timestamp; keyboard toggling also advances recurring items but the timestamp behavior differs.

## Other metadata forms

- Phosphor also supports `@due(YYYY-MM-DD)` and `@repeat(<interval>)` forms which are functionally equivalent to the emoji forms above.
- Completion timestamps are detected/parsed if present in the line (the editor looks for `✓ YYYY-MM-DD HH:MM:SS`).

## Tasks panel (Tasks View)

- Open the Tasks panel to see an index of all tasks across your vault.
- Tasks are grouped by file and sorted by urgency (overdue → today → upcoming → no-date), then by due date and line number.
- Each task shows:
  - status icon (`○`, `◐`, `✓`)
  - task text
  - completion time (if done)
  - due date (if present)
  - file and line number (clicking a task navigates to that line in the note)

Filters available in the Tasks panel:

- Status filter: All / Todo / Doing / Done
- Due date filter: All / Overdue / Today / Upcoming / No Date

## Examples

1. Simple todo

- [ ] Call Alice

2. Todo with due date (emoji)

- [ ] Project proposal 📅 2026-02-01

3. Todo with due date (Phosphor meta)

- [ ] Project proposal @due(2026-02-01)

4. Recurring weekly task

- [ ] Run report 📅 2026-01-16 🔁 +1w

5. Org-mode style deadline

- [ ] Submit invoice DEADLINE: <2026-02-10>

## Tips and gotchas

- Keep the checkbox at the start of a bullet line (e.g., `- [ ] ...`) for it to be detected.
- The click indicator and keyboard shortcut both toggle state; if you rely on automatic completion timestamps prefer clicking the indicator.
- Recurrence intervals are applied to parsed due dates; if no due date is present the editor won't automatically create future occurrences.

If something in this guide looks incorrect for your workflow, open an issue or check the task lines in your note to confirm the exact metadata syntax used.

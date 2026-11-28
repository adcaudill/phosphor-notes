---
title: Slash Commands
layout: page
---

# Slash Commands

The editor includes a quick "slash" menu that helps you insert dates, headings, and other common content using short commands.

**How to open**

- Type `/` anywhere in the editor to open the slash menu.
- Continue typing to filter commands (for example, type `/tod` to find `/today`).
- Use the arrow keys to navigate suggestions and press Enter or Tab to insert the selected command.

**Behavior**

- Choosing a command replaces the typed slash command (including the leading `/`) with the inserted content.
- Date commands insert wikilinks using ISO dates (YYYY-MM-DD), e.g. `[[2026-01-19]]`.
- Heading commands insert Markdown heading markers (e.g. `# ` for H1).

**Available commands**

- `/task` — Create a task: type it in plain language (e.g. `pay rent on the first of each month !high`) and press Enter. A link to the new task is inserted. On a `- [ ]` checkbox line, it converts that line into a task instead. See [Task Management](task_management.md).
- `/convert-tasks` — Convert this note's checkbox tasks that have dates, repeats or priorities into tasks.

- `/today` — Insert today's date as a wikilink (e.g. `[[2026-01-19]]`).
- `/tomorrow` — Insert tomorrow's date as a wikilink.
- `/yesterday` — Insert yesterday's date as a wikilink.
- `/monday`, `/tuesday`, `/wednesday`, `/thursday`, `/friday`, `/saturday`, `/sunday` — Insert the next occurrence of the named weekday as a wikilink.

- `/h1` — Insert an H1 heading marker (`# `).
- `/h2` — Insert an H2 heading marker (`## `).
- `/h3` — Insert an H3 heading marker (`### `).
- `/h4` — Insert an H4 heading marker (`#### `).
- `/h5` — Insert an H5 heading marker (`##### `).
- `/h6` — Insert an H6 heading marker (`###### `).

**Tips**

- The menu is fuzzy: partial typing will match available commands (typing `/tod` matches `/today`).

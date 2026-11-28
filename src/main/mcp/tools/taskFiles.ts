/**
 * MCP tools for task files (`_tasks/`): the app's tasks.
 *
 * Read (always): list_tasks, search_tasks, get_task.
 * Write tier: create_task, complete_task, skip_occurrence, add_task_comment.
 * Edit tier: update_task, update_checklist.
 * Delete tier: delete_task.
 * Every write also needs the user's "Allow changes to tasks" setting, since
 * tasks belong to no folder and the folder scope can't cover them. Like the
 * note tools, a tool is only registered when its tier is on, so the tool list
 * shows what an AI app may do.
 *
 * Dates, repeats and the rest are structured fields - never syntax embedded
 * in text. `create_task` also takes plain language (`input`), parsed the
 * same way the app's own capture field parses it.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps, WriteCtx } from '../deps';
import { withVaultGuard, withVaultWriteGuard } from '../toolkit';
import { InvalidArgumentError } from '../../../shared/noteFormat';
import {
  TASK_STATUSES,
  isValidDate,
  isValidDue,
  type TaskRecord
} from '../../../shared/taskRecord';
import {
  addComment,
  applyTaskPatch,
  completeTask,
  skipOccurrence,
  type NewTaskInput,
  type TaskPatch
} from '../../../shared/taskOps';
import { describeRepeat } from '../../../shared/taskRepeat';
import { parseRepeatPhrase, parseTaskInput, toNewTaskInput } from '../../../shared/taskParse';
import {
  TASK_VIEWS,
  inView,
  parseTaskFilter,
  sortTasks,
  type TaskViewId
} from '../../../shared/taskQuery';
import { formatTaskLink } from '../../../shared/taskLinks';
import { localDate } from '../../../shared/taskRecord';
import type { TaskSummary } from '../../../shared/taskViews';

export class TasksDisabledError extends Error {
  constructor() {
    super(
      "Changes to tasks are turned off. Ask the user to enable 'Allow changes to tasks' in Phosphor Notes' Settings > AI Access."
    );
    this.name = 'TasksDisabledError';
  }
}

const VIEW_IDS = TASK_VIEWS.map((v) => v.id) as [TaskViewId, ...TaskViewId[]];
const PRIORITIES = ['high', 'medium', 'low'] as const;

const taskOut = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]),
  priority: z.enum(PRIORITIES).optional(),
  due: z.string().optional(),
  start: z.string().optional(),
  repeat: z
    .object({
      rule: z.string(),
      from: z.enum(['due', 'completion']),
      until: z.string().optional(),
      count: z.number().optional(),
      label: z.string()
    })
    .optional(),
  project: z.string().optional(),
  tags: z.array(z.string()),
  waitingOn: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  completed: z.string().optional(),
  checklist: z.array(z.object({ text: z.string(), done: z.boolean() })),
  linkedNotes: z.array(z.string()).optional(),
  notes: z.string().optional(),
  log: z.array(z.record(z.string(), z.unknown())).optional()
});

type TaskOut = z.infer<typeof taskOut>;

/** A task as tools return it: fields, a readable repeat label, and (in full) notes and the activity log. */
function toOut(t: TaskSummary | TaskRecord, full = false): TaskOut {
  const out: TaskOut = {
    id: t.id,
    title: t.title,
    status: t.status,
    tags: t.tags,
    checklist: t.checklist
  };
  if (t.priority) out.priority = t.priority;
  if (t.due) out.due = t.due;
  if (t.start) out.start = t.start;
  if (t.repeat) out.repeat = { ...t.repeat, label: describeRepeat(t.repeat) };
  if (t.project) out.project = t.project;
  if (t.waitingOn) out.waitingOn = t.waitingOn;
  if (t.created) out.created = t.created;
  if (t.updated) out.updated = t.updated;
  if (t.completed) out.completed = t.completed;
  if ('linkedNotes' in t) out.linkedNotes = t.linkedNotes;
  if (full && 'notes' in t) {
    out.notes = t.notes;
    out.log = t.log;
  }
  return out;
}

function requireTaskWrites(deps: McpDeps): void {
  if (!deps.isTaskWriteEnabled()) throw new TasksDisabledError();
}

const dueField = z
  .string()
  .refine(isValidDue, 'a date (YYYY-MM-DD) or date and time (YYYY-MM-DDTHH:MM)');
const dateField = z.string().refine(isValidDate, 'a date (YYYY-MM-DD)');

function resolveRepeat(
  repeat: string,
  due: string | undefined
): NonNullable<TaskPatch['repeat']> & {
  firstDue: string;
} {
  const r = parseRepeatPhrase(repeat, { due });
  if (!r) {
    throw new InvalidArgumentError(
      `repeat "${repeat}" isn't a repeat the app understands - try e.g. "daily", "every mon and thu", "monthly on the 1st", "every 3 days after done"`
    );
  }
  return { ...r.repeat, firstDue: r.due };
}

function query(
  deps: McpDeps,
  opts: { view?: TaskViewId; filter?: string; limit: number }
): { tasks: TaskOut[]; total: number } {
  const snapshot = deps.tasks.list();
  if (!snapshot.ready)
    throw Object.assign(new Error('tasks are still loading'), { name: 'IndexNotReadyError' });
  const today = localDate();
  const f = parseTaskFilter(opts.filter ?? '');
  const ids = f.text ? new Set(deps.tasks.search(f.text)) : null;
  const matched = snapshot.tasks.filter(
    (t) =>
      (!opts.view || inView(t, opts.view, today)) && f.test(t, { today }) && (!ids || ids.has(t.id))
  );
  const sorted = sortTasks(matched, 'due', opts.view);
  return { tasks: sorted.slice(0, opts.limit).map((t) => toOut(t)), total: sorted.length };
}

const listOutput = { tasks: z.array(taskOut), total: z.number() };

export function registerTaskFileReadTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        "List the user's tasks. `view` picks one of the app's views - inbox (no date or project yet), " +
        'today (due today, overdue, or starting today), upcoming (next 14 days), anytime (open, no due ' +
        'date), waiting, scheduled (starting later), logbook (done and cancelled), all. `filter` takes ' +
        'free text (full-text across title, notes, checklist and comments) and/or filters: ' +
        'status:todo|doing|waiting|done|cancelled|open, priority:high|medium|low|none, due:today|overdue|' +
        '<7d|>2026-12-01|none, start:>today, completed:today|week|last-week|month, #tag, +Project, ' +
        '+"Multi Word", has:notes|checklist|comments, repeat:yes|no, linked:yes|no, in:"Note name". ' +
        'Sorted by due date. Defaults to all open tasks.',
      inputSchema: {
        view: z.enum(VIEW_IDS).optional(),
        filter: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(1000).optional().default(100)
      },
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard('list_tasks', deps, async ({ view, filter, limit }) =>
      query(deps, { view, filter: view || filter ? filter : 'status:open', limit })
    )
  );

  server.registerTool(
    'search_tasks',
    {
      title: 'Search tasks',
      description:
        "Full-text search across the user's tasks - title, notes, checklist steps, comments, project " +
        'and tags (every word must match; prefixes match too). Accepts the same filters as list_tasks.',
      inputSchema: {
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(1000).optional().default(50)
      },
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard('search_tasks', deps, async ({ query: q, limit }) =>
      query(deps, { filter: q, limit })
    )
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get a task',
      description:
        'One task in full: fields, notes, checklist, activity log (status changes, completions, ' +
        'comments), and the notes (with line numbers) that link to it.',
      inputSchema: { id: z.string().min(1).max(16) },
      outputSchema: {
        task: taskOut,
        links: z.array(z.object({ note: z.string(), line: z.number() }))
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard('get_task', deps, async ({ id }) => {
      const detail = deps.tasks.get(id);
      if (!detail)
        throw Object.assign(new Error(`Task not found: ${id}`), { name: 'TaskNotFoundError' });
      return { task: toOut(detail.task, true), links: detail.links };
    })
  );
}

const taskResult = { task: taskOut };

export function registerTaskFileWriteTools(server: McpServer, deps: McpDeps): void {
  const writeTool = <A>(
    name: string,
    handler: (args: A, ctx: WriteCtx) => Promise<Record<string, unknown>>,
    tier: 'write' | 'edit' | 'delete' = 'write'
  ): ((args: A) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>) =>
    withVaultWriteGuard<A, Record<string, unknown>>(
      name,
      deps,
      async (args, ctx) => {
        requireTaskWrites(deps);
        return handler(args, ctx);
      },
      (args) => (args as { id?: string }).id,
      { tier }
    );

  server.registerTool(
    'create_task',
    {
      title: 'Create a task',
      description:
        'Create a task. Either give `input` in plain language, read exactly as the app reads typed ' +
        'tasks ("pay rent on the first of each month !high #bills +Home", "call Alice fri at 3pm", ' +
        '"water the fern every 3 days after done", "quote from supplier waiting on Bob"), or give ' +
        '`title` plus structured fields (which also override anything read from `input`). `repeat` ' +
        'is a phrase like "weekly on mon", "every 2 weeks", "monthly on the last day". Optionally ' +
        'link it into a note with `linkInto` (appended, or under a bullet) - that note must be ' +
        'within the folders AI apps may change.',
      inputSchema: {
        input: z.string().max(1000).optional(),
        title: z.string().max(500).optional(),
        status: z.enum(['todo', 'doing', 'waiting']).optional(),
        due: dueField.optional(),
        start: dateField.optional(),
        repeat: z.string().max(200).optional(),
        priority: z.enum(PRIORITIES).optional(),
        project: z.string().max(200).optional(),
        tags: z.array(z.string().max(100)).max(50).optional(),
        waitingOn: z.string().max(200).optional(),
        notes: z.string().max(100_000).optional(),
        checklist: z.array(z.string().max(500)).max(200).optional(),
        linkInto: z
          .object({
            note: z.string().min(1),
            underBullet: z
              .string()
              .optional()
              .describe('Insert the link as a child of the bullet with this text (outliner notes)')
          })
          .optional()
      },
      outputSchema: { task: taskOut, linkedInto: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    writeTool<{
      input?: string;
      title?: string;
      status?: 'todo' | 'doing' | 'waiting';
      due?: string;
      start?: string;
      repeat?: string;
      priority?: (typeof PRIORITIES)[number];
      project?: string;
      tags?: string[];
      waitingOn?: string;
      notes?: string;
      checklist?: string[];
      linkInto?: { note: string; underBullet?: string };
    }>('create_task', async (a, ctx) => {
      const base: NewTaskInput = a.input ? toNewTaskInput(parseTaskInput(a.input)) : { title: '' };
      const input: NewTaskInput = { ...base };
      if (a.title !== undefined) input.title = a.title;
      if (!input.title?.trim()) {
        throw new InvalidArgumentError(
          'a title is needed - give `title`, or `input` with some text'
        );
      }
      if (/\n/.test(input.title)) throw new InvalidArgumentError('title must be a single line');
      if (a.status) input.status = a.status;
      if (a.due) input.due = a.due;
      if (a.start) input.start = a.start;
      if (a.priority) input.priority = a.priority;
      if (a.project) input.project = a.project;
      if (a.tags) input.tags = a.tags;
      if (a.waitingOn) {
        input.waitingOn = a.waitingOn;
        input.status ??= 'waiting';
      }
      if (a.notes) input.notes = a.notes;
      if (a.checklist) input.checklist = a.checklist.map((text) => ({ text, done: false }));
      if (a.repeat) {
        const { firstDue, ...repeat } = resolveRepeat(a.repeat, input.due);
        input.repeat = repeat;
        input.due ??= firstDue;
      }

      // Check the link can go where asked (folder scope, unsaved edits, the
      // bullet exists) before writing anything.
      if (a.linkInto) {
        const probe = `- ${formatTaskLink('aaaaaaaa', input.title)}`;
        if (a.linkInto.underBullet) {
          await deps.insertUnderBullet(a.linkInto.note, a.linkInto.underBullet, probe, ctx, {
            dryRun: true
          });
        } else {
          await deps.appendToNote(a.linkInto.note, probe, ctx, undefined, { dryRun: true });
        }
      }

      const task = await deps.tasks.create(input, ctx);
      if (!a.linkInto) return { task: toOut(task) };

      const line = `- ${formatTaskLink(task.id, task.title)}`;
      try {
        if (a.linkInto.underBullet) {
          await deps.insertUnderBullet(a.linkInto.note, a.linkInto.underBullet, line, ctx);
        } else {
          await deps.appendToNote(a.linkInto.note, line, ctx);
        }
      } catch (err) {
        // Don't leave a task the caller didn't get linked where they asked.
        await deps.tasks.delete(task.id, ctx).catch(() => undefined);
        throw err;
      }
      return { task: toOut(task), linkedInto: a.linkInto.note };
    })
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete a task',
      description:
        'Mark a task done. A repeating task moves to its next occurrence instead (status back to ' +
        'todo, due date advanced, checklist reset) and the completion is logged.',
      inputSchema: { id: z.string().min(1).max(16) },
      outputSchema: taskResult,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    writeTool<{ id: string }>('complete_task', async ({ id }, ctx) => ({
      task: toOut(await deps.tasks.update(id, (t) => completeTask(t), ctx, 'Completed task'))
    }))
  );

  server.registerTool(
    'skip_occurrence',
    {
      title: 'Skip an occurrence',
      description:
        "Skip a repeating task's current occurrence: it moves to the next one without being completed.",
      inputSchema: { id: z.string().min(1).max(16) },
      outputSchema: taskResult,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    writeTool<{ id: string }>('skip_occurrence', async ({ id }, ctx) => ({
      task: toOut(await deps.tasks.update(id, (t) => skipOccurrence(t), ctx, 'Skipped occurrence'))
    }))
  );

  server.registerTool(
    'add_task_comment',
    {
      title: 'Comment on a task',
      description: "Add a comment to a task's activity log (Markdown).",
      inputSchema: { id: z.string().min(1).max(16), text: z.string().min(1).max(20_000) },
      outputSchema: taskResult,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    writeTool<{ id: string; text: string }>('add_task_comment', async ({ id, text }, ctx) => ({
      task: toOut(
        await deps.tasks.update(id, (t) => addComment(t, text), ctx, 'Added comment'),
        true
      )
    }))
  );

  if (!deps.isEditEnabled()) return;

  server.registerTool(
    'update_task',
    {
      title: 'Update a task',
      description:
        "Change a task's fields. Pass only what changes; null clears an optional field. `repeat` is " +
        'a phrase ("weekly on mon", "monthly on the 15th"). Renaming also updates the title text in ' +
        'links to the task in notes (notes open with unsaved edits in the app are skipped and listed).',
      inputSchema: {
        id: z.string().min(1).max(16),
        title: z.string().min(1).max(500).optional(),
        status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
        due: dueField.nullable().optional(),
        start: dateField.nullable().optional(),
        repeat: z.string().max(200).nullable().optional(),
        priority: z.enum(PRIORITIES).nullable().optional(),
        project: z.string().max(200).nullable().optional(),
        tags: z.array(z.string().max(100)).max(50).optional(),
        waitingOn: z.string().max(200).nullable().optional(),
        notes: z.string().max(100_000).optional()
      },
      outputSchema: {
        task: taskOut,
        linksUpdated: z.array(z.string()).optional(),
        linksSkipped: z.array(z.string()).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    writeTool<{
      id: string;
      title?: string;
      status?: string;
      due?: string | null;
      start?: string | null;
      repeat?: string | null;
      priority?: (typeof PRIORITIES)[number] | null;
      project?: string | null;
      tags?: string[];
      waitingOn?: string | null;
      notes?: string;
    }>(
      'update_task',
      async ({ id, repeat, status, ...rest }, ctx) => {
        if (rest.title !== undefined && /\n/.test(rest.title)) {
          throw new InvalidArgumentError('title must be a single line');
        }
        const before = deps.tasks.get(id)?.task;
        let titleChanged = false;
        const task = await deps.tasks.update(
          id,
          (t) => {
            const patch: TaskPatch = { ...rest };
            if (status) patch.status = status as TaskPatch['status'];
            if (repeat === null) patch.repeat = null;
            else if (repeat !== undefined) {
              const due = patch.due === undefined ? t.due : (patch.due ?? undefined);
              const { firstDue, ...r } = resolveRepeat(repeat, due);
              patch.repeat = r;
              if (!due) patch.due = firstDue;
            }
            titleChanged = rest.title !== undefined && rest.title.trim() !== t.title;
            return applyTaskPatch(t, patch);
          },
          ctx,
          'Updated task'
        );
        if (!titleChanged || !before) return { task: toOut(task) };
        const sync = await deps.tasks.syncLinkTitles(id, task.title, ctx);
        return { task: toOut(task), linksUpdated: sync.changed, linksSkipped: sync.skipped };
      },
      'edit'
    )
  );

  server.registerTool(
    'update_checklist',
    {
      title: "Update a task's checklist",
      description:
        "Replace a task's checklist with the given steps, in order (to tick a step, send the list with " +
        'it marked done). Use get_task first to see the current list.',
      inputSchema: {
        id: z.string().min(1).max(16),
        items: z
          .array(z.object({ text: z.string().min(1).max(500), done: z.boolean().default(false) }))
          .max(200)
      },
      outputSchema: taskResult,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    writeTool<{ id: string; items: Array<{ text: string; done: boolean }> }>(
      'update_checklist',
      async ({ id, items }, ctx) => ({
        task: toOut(
          await deps.tasks.update(
            id,
            (t) =>
              applyTaskPatch(t, { checklist: items.map((i) => ({ text: i.text, done: i.done })) }),
            ctx,
            'Updated checklist'
          )
        )
      }),
      'edit'
    )
  );

  if (!deps.isDeleteEnabled()) return;

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description:
        "Delete a task. It's saved to history first, so the user can restore it. Links to it in notes " +
        'stay, and show it as deleted. Prefer completing or cancelling (update_task status) - delete ' +
        'only when the user asks.',
      inputSchema: { id: z.string().min(1).max(16) },
      outputSchema: { deleted: z.string(), linkedFrom: z.array(z.string()) },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    writeTool<{ id: string }>(
      'delete_task',
      async ({ id }, ctx) => {
        const linkedFrom = [...new Set((deps.tasks.get(id)?.links ?? []).map((l) => l.note))];
        await deps.tasks.delete(id, ctx);
        return { deleted: id, linkedFrom };
      },
      'delete'
    )
  );
}

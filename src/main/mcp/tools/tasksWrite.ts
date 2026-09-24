import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultWriteGuard } from '../toolkit';
import { buildNewNoteFrontmatter, InvalidArgumentError } from '../../../shared/noteFormat';
import {
  formatTaskLine,
  parseTaskLine,
  serializeTaskLine,
  buildRecurrenceAdvance,
  getCurrentTimestamp,
  TASK_LINE_RE,
  type ParsedTaskLine,
  type RecurrenceUnit
} from '../../../shared/tasks';

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCE_RE = /^\+\d+[dwmy]$/i;

function requireTaskLine(rawText: string): ParsedTaskLine {
  const parsed = parseTaskLine(rawText);
  if (!parsed) {
    throw new InvalidArgumentError('rawText must be a task checkbox line ("- [ ]/[/]/[x] ...")');
  }
  return parsed;
}

export function registerTaskWriteTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'add_task',
    {
      title: 'Add a task',
      description:
        "Add one checkbox task (\"- [ ] ...\") to the end of a note - by default to today's daily " +
        "journal, which is auto-created if it doesn't exist yet. An explicitly-named `file` is " +
        'never auto-created (use create_note first if needed). Encode the due date, recurrence, and ' +
        "priority as separate options, using the app's own syntax under the hood (📅 YYYY-MM-DD, " +
        '🔁 +1d / +2w / +1m / +1y, 🔺/🔼/🔽) - do not embed them in `text` yourself.',
      inputSchema: {
        text: z.string().min(1).max(1000).describe('The task description, a single line.'),
        file: z
          .string()
          .optional()
          .describe("Vault-relative path. Omit to use today's daily note."),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD'),
        recurrence: z
          .string()
          .regex(/^\+\d+[dwmy]$/i)
          .optional()
          .describe('e.g. +1d, +2w, +1m, +1y'),
        priority: z.enum(['high', 'medium', 'low']).optional(),
        status: z.enum(['todo', 'doing']).optional().default('todo')
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
        mode: z.enum(['freeform', 'outliner']),
        line: z.number(),
        taskLine: z.string()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'add_task',
      deps,
      async (
        {
          text,
          file,
          due,
          recurrence,
          priority,
          status
        }: {
          text: string;
          file?: string;
          due?: string;
          recurrence?: string;
          priority?: 'high' | 'medium' | 'low';
          status?: 'todo' | 'doing';
        },
        ctx
      ) => {
        const taskLine = formatTaskLine({ text, due, recurrence, priority, status });
        const target = file ?? deps.todayDailyNotePath();
        const createIfMissing =
          file === undefined
            ? {
                frontmatter: buildNewNoteFrontmatter(target, await deps.getDefaultJournalMode())
              }
            : undefined;

        const result = await deps.appendToNote(target, taskLine, ctx, createIfMissing);
        return {
          path: result.path,
          created: result.created,
          mode: result.mode,
          line: result.endLine,
          taskLine
        };
      },
      (args) => args.file
    )
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete a task',
      description:
        'Marks a task done, with a completion timestamp. If it has a supported recurrence (d/w/m/y) ' +
        'and a due date, also inserts the next occurrence as a new line right below it - exactly ' +
        'what clicking the checkbox in the app does. Pass the `rawText` last returned by list_tasks ' +
        'for this task; the write is refused (LINE_MISMATCH) if the line has since changed.',
      inputSchema: {
        file: z.string(),
        line: z.number().int().min(1),
        rawText: z.string()
      },
      outputSchema: {
        path: z.string(),
        line: z.number(),
        completedLine: z.string(),
        nextLine: z.string().optional(),
        nextLineNumber: z.number().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'complete_task',
      deps,
      async ({ file, line, rawText }: { file: string; line: number; rawText: string }, ctx) => {
        requireTaskLine(rawText);
        const { completedLine, nextLine } = buildRecurrenceAdvance(rawText);
        const newLines = nextLine ? [completedLine, nextLine] : [completedLine];

        const result = await deps.replaceLines(file, { line, expectedText: rawText }, newLines, ctx);
        return {
          path: result.path,
          line: result.line,
          completedLine,
          nextLine: nextLine ?? undefined,
          nextLineNumber: nextLine ? line + 1 : undefined
        };
      },
      (args) => args.file
    )
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update a task',
      description:
        "Edits a task's text and/or status/due date/recurrence/priority in place, without needing " +
        'to hand-construct emoji syntax. Pass only the fields you want to change; omitted fields keep ' +
        'their current value. To clear the due date or recurrence pass "" (empty string); to clear ' +
        'priority pass "none". Setting status to "done" here just marks it done (with a fresh ' +
        'completion timestamp) - it does not generate a next occurrence for a recurring task; use ' +
        'complete_task for that. Pass the `rawText` last returned by list_tasks for this task.',
      inputSchema: {
        file: z.string(),
        line: z.number().int().min(1),
        rawText: z.string(),
        newText: z.string().min(1).max(1000).optional(),
        due: z.union([z.string().regex(DUE_DATE_RE), z.literal('')]).optional(),
        recurrence: z.union([z.string().regex(RECURRENCE_RE), z.literal('')]).optional(),
        priority: z.enum(['high', 'medium', 'low', 'none']).optional(),
        status: z.enum(['todo', 'doing', 'done']).optional()
      },
      outputSchema: { path: z.string(), line: z.number(), taskLine: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'update_task',
      deps,
      async (
        args: {
          file: string;
          line: number;
          rawText: string;
          newText?: string;
          due?: string;
          recurrence?: string;
          priority?: 'high' | 'medium' | 'low' | 'none';
          status?: 'todo' | 'doing' | 'done';
        },
        ctx
      ) => {
        const parsed = requireTaskLine(args.rawText);
        const indent = TASK_LINE_RE.exec(args.rawText)![1];

        const nextText = args.newText !== undefined ? args.newText.trim() : parsed.text;
        if (nextText === '') {
          throw new InvalidArgumentError('newText must be a non-empty string');
        }

        const nextStatus = args.status ?? parsed.status;
        const nextDue = args.due === undefined ? parsed.dueDate : args.due === '' ? undefined : args.due;

        let nextRecurrence: { amount: number; unit: RecurrenceUnit } | undefined =
          parsed.recurrence?.supported
            ? { amount: parsed.recurrence.amount, unit: parsed.recurrence.unit }
            : undefined;
        if (args.recurrence !== undefined) {
          if (args.recurrence === '') {
            nextRecurrence = undefined;
          } else {
            const m = /^\+(\d+)([dwmy])$/i.exec(args.recurrence)!;
            nextRecurrence = { amount: parseInt(m[1], 10), unit: m[2].toLowerCase() as RecurrenceUnit };
          }
        }

        const nextPriority =
          args.priority === undefined ? parsed.priority : args.priority === 'none' ? undefined : args.priority;

        const nextCompletedAt =
          nextStatus === 'done'
            ? parsed.status === 'done'
              ? parsed.completedAt
              : getCurrentTimestamp()
            : undefined;

        const taskLine = serializeTaskLine(indent, nextStatus, nextText, {
          due: nextDue,
          recurrence: nextRecurrence,
          priority: nextPriority,
          completedAt: nextCompletedAt
        });

        const result = await deps.replaceLines(
          args.file,
          { line: args.line, expectedText: args.rawText },
          [taskLine],
          ctx
        );
        return { path: result.path, line: result.line, taskLine };
      },
      (args) => args.file
    )
  );

  server.registerTool(
    'reschedule_task',
    {
      title: 'Reschedule a task',
      description:
        "Sets or clears a task's due date - a focused wrapper over update_task for the common " +
        '"move this to a new date" action. Pass "" to clear the due date.',
      inputSchema: {
        file: z.string(),
        line: z.number().int().min(1),
        rawText: z.string(),
        due: z.union([z.string().regex(DUE_DATE_RE), z.literal('')])
      },
      outputSchema: { path: z.string(), line: z.number(), taskLine: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'reschedule_task',
      deps,
      async (
        { file, line, rawText, due }: { file: string; line: number; rawText: string; due: string },
        ctx
      ) => {
        const parsed = requireTaskLine(rawText);
        const indent = TASK_LINE_RE.exec(rawText)![1];

        const taskLine = serializeTaskLine(indent, parsed.status, parsed.text, {
          due: due === '' ? undefined : due,
          recurrence: parsed.recurrence?.supported
            ? { amount: parsed.recurrence.amount, unit: parsed.recurrence.unit }
            : undefined,
          priority: parsed.priority,
          completedAt: parsed.completedAt
        });

        const result = await deps.replaceLines(file, { line, expectedText: rawText }, [taskLine], ctx);
        return { path: result.path, line: result.line, taskLine };
      },
      (args) => args.file
    )
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description:
        'Permanently removes one task line. Pass the `rawText` last returned by list_tasks for it.',
      inputSchema: {
        file: z.string(),
        line: z.number().int().min(1),
        rawText: z.string()
      },
      outputSchema: { path: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'delete_task',
      deps,
      async ({ file, line, rawText }: { file: string; line: number; rawText: string }, ctx) => {
        requireTaskLine(rawText);
        const result = await deps.replaceLines(file, { line, expectedText: rawText }, [], ctx);
        return { path: result.path };
      },
      (args) => args.file
    )
  );
}

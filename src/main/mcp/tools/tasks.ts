import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, IndexNotReadyError } from '../toolkit';
import { isPastDate } from '../../../shared/tasks';

const STATUS_VALUES = ['todo', 'doing', 'done', 'open'] as const;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TaskFilterArgs {
  status?: (typeof STATUS_VALUES)[number];
  file?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  limit?: number;
}

export function registerTaskTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks (checkbox lines, e.g. "- [ ] ...") across the vault, with optional filters. ' +
        'Note: a task is identified by (file, line) - the line number is a snapshot and can drift ' +
        'if the file is edited concurrently. To later complete/update/reschedule/delete a task, ' +
        'pass its `file`, `line`, and the exact `rawText` this tool returned for it - the write ' +
        'tools verify the line still reads exactly that before changing anything, and refuse ' +
        '(LINE_MISMATCH) if it has since changed, so you never silently edit the wrong line.',
      inputSchema: {
        status: z.enum(STATUS_VALUES).optional().describe('"open" means todo or doing combined'),
        file: z.string().optional().describe('Restrict to tasks in this vault-relative file'),
        dueBefore: z
          .string()
          .regex(ISO_DATE_RE)
          .optional()
          .describe('YYYY-MM-DD, exclusive upper bound on due date'),
        dueAfter: z
          .string()
          .regex(ISO_DATE_RE)
          .optional()
          .describe('YYYY-MM-DD, exclusive lower bound on due date'),
        overdue: z.boolean().optional().describe('Only tasks whose due date is in the past'),
        limit: z.number().int().min(1).max(1000).optional().default(200)
      },
      outputSchema: {
        tasks: z.array(
          z.object({
            file: z.string(),
            line: z.number(),
            status: z.enum(['todo', 'doing', 'done']),
            text: z.string(),
            rawText: z.string(),
            dueDate: z.string().optional(),
            recurrence: z
              .object({
                amount: z.number(),
                unit: z.string(),
                supported: z.boolean()
              })
              .optional(),
            priority: z.enum(['high', 'medium', 'low']).optional(),
            completedAt: z.string().optional()
          })
        ),
        total: z.number()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'list_tasks',
      deps,
      async ({ status, file, dueBefore, dueAfter, overdue, limit }: TaskFilterArgs) => {
        const allTasks = deps.getTasks();
        if (allTasks === null) {
          throw new IndexNotReadyError();
        }

        const filtered = allTasks.filter((task) => {
          if (status) {
            if (status === 'open') {
              if (task.status === 'done') return false;
            } else if (task.status !== status) {
              return false;
            }
          }
          if (file && task.file !== file) return false;

          if ((dueBefore || dueAfter || overdue) && !task.dueDate) return false;
          if (dueBefore && task.dueDate && !(task.dueDate < dueBefore)) return false;
          if (dueAfter && task.dueDate && !(task.dueDate > dueAfter)) return false;
          if (overdue && task.dueDate && !isPastDate(task.dueDate)) return false;

          return true;
        });

        const pageSize = limit ?? 200;
        return {
          tasks: filtered.slice(0, pageSize),
          total: filtered.length
        };
      }
    )
  );
}

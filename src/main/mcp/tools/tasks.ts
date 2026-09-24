import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, IndexNotReadyError } from '../toolkit';
import { isPast } from '../../../shared/taskParser';

const STATUS_VALUES = ['todo', 'doing', 'done', 'open'] as const;

interface TaskFilterArgs {
  status?: (typeof STATUS_VALUES)[number];
  file?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdue?: boolean;
  limit?: number;
}

function parseIsoDate(value: string): Date | null {
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (!match) return null;
  return new Date(value + 'T00:00:00Z');
}

export function registerTaskTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks (checkbox lines, e.g. "- [ ] ...") across the vault, with optional filters. ' +
        'Note: a task is identified by (file, line) - the line number is a snapshot and can drift ' +
        'if the file is edited concurrently.',
      inputSchema: {
        status: z.enum(STATUS_VALUES).optional().describe('"open" means todo or doing combined'),
        file: z.string().optional().describe('Restrict to tasks in this vault-relative file'),
        dueBefore: z.string().optional().describe('YYYY-MM-DD, exclusive upper bound on due date'),
        dueAfter: z.string().optional().describe('YYYY-MM-DD, exclusive lower bound on due date'),
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
            dueDate: z.string().optional(),
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

        const before = dueBefore ? parseIsoDate(dueBefore) : null;
        const after = dueAfter ? parseIsoDate(dueAfter) : null;

        const filtered = allTasks.filter((task) => {
          if (status) {
            if (status === 'open') {
              if (task.status === 'done') return false;
            } else if (task.status !== status) {
              return false;
            }
          }
          if (file && task.file !== file) return false;

          if ((before || after || overdue) && !task.dueDate) return false;
          const due = task.dueDate ? parseIsoDate(task.dueDate) : null;
          if (before && due && !(due < before)) return false;
          if (after && due && !(due > after)) return false;
          if (overdue && due && !isPast(due)) return false;

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

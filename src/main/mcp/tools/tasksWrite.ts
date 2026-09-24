import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultWriteGuard } from '../toolkit';
import { formatTaskLine, buildNewNoteFrontmatter } from '../../../shared/noteFormat';

export function registerTaskWriteTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'add_task',
    {
      title: 'Add a task',
      description:
        "Add one checkbox task (\"- [ ] ...\") to the end of a note - by default to today's daily " +
        "journal, which is auto-created if it doesn't exist yet. An explicitly-named `file` is " +
        'never auto-created (use create_note first if needed). Encode the due date and recurrence ' +
        'as separate options, using the app\'s own syntax under the hood (📅 YYYY-MM-DD, and ' +
        '🔁 +1d / +2w / +1m / +1y) - do not embed them in `text` yourself.',
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
          status
        }: {
          text: string;
          file?: string;
          due?: string;
          recurrence?: string;
          status?: 'todo' | 'doing';
        },
        ctx
      ) => {
        const taskLine = formatTaskLine({ text, due, recurrence, status });
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
}

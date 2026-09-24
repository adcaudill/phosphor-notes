import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultWriteGuard } from '../toolkit';

export function registerNoteWriteTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a new note at a vault-relative path. Refuses to overwrite an existing note unless ' +
        '`overwrite` is explicitly true (in which case the previous content is backed up to a ' +
        '.bak file first). If `content` already includes its own frontmatter, omit `mode`. ' +
        "Otherwise: daily-note-named files (\"YYYY-MM-DD.md\") default to the user's own daily " +
        'journal mode setting; anything else defaults to freeform. In outliner mode, each line of ' +
        '`content` becomes its own top-level bullet. Parent-folder stub notes are auto-created for ' +
        'nested paths, same as creating a note from the app itself.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Projects/Plan.md"'),
        content: z.string().max(200_000).optional().describe('Plain body text, or a full document including its own frontmatter.'),
        mode: z.enum(['freeform', 'outliner']).optional(),
        overwrite: z.boolean().optional().default(false)
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
        overwritten: z.boolean(),
        mode: z.enum(['freeform', 'outliner']),
        parentsCreated: z.array(z.string()),
        backupPath: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'create_note',
      deps,
      async (
        {
          path: relPath,
          content,
          mode,
          overwrite
        }: { path: string; content?: string; mode?: 'freeform' | 'outliner'; overwrite?: boolean },
        ctx
      ) => {
        const result = await deps.createNote(relPath, content ?? '', { mode, overwrite }, ctx);
        return {
          path: result.path,
          created: result.created,
          overwritten: result.overwritten,
          mode: result.mode,
          parentsCreated: result.parentsCreated,
          backupPath: result.backupPath
        };
      },
      (args) => args.path
    )
  );

  server.registerTool(
    'append_to_note',
    {
      title: 'Append to a note',
      description:
        'Add content to the end of an existing note - the only way to modify an existing note ' +
        'through this connection (there is no tool that replaces or edits the middle of a note). ' +
        'Mode is always detected from the note\'s own frontmatter, never a parameter here: an ' +
        'outliner note gets new top-level bullets (existing indentation/nesting is preserved), a ' +
        'freeform note gets a new paragraph. Fails with NOTE_NOT_FOUND rather than creating the ' +
        'file - use create_note first if it doesn\'t exist yet.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "People/John.md"'),
        content: z.string().min(1).max(100_000)
      },
      outputSchema: {
        path: z.string(),
        mode: z.enum(['freeform', 'outliner']),
        appended: z.string()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'append_to_note',
      deps,
      async ({ path: relPath, content }: { path: string; content: string }, ctx) => {
        const result = await deps.appendToNote(relPath, content, ctx);
        return { path: result.path, mode: result.mode, appended: result.appended };
      },
      (args) => args.path
    )
  );
}

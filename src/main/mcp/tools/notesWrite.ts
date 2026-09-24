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
        'through this connection (there is no tool that replaces or edits the middle of a note; ' +
        'to add content under a specific existing bullet elsewhere in an outliner note, use ' +
        'insert_under_bullet instead). Mode is always detected from the note\'s own frontmatter, ' +
        'never a parameter here. In a freeform note, content becomes a new paragraph. In an ' +
        'outliner note, each line of content becomes its own bullet and relative indentation is ' +
        'preserved (re-based to the app\'s 4-space convention): an unindented line becomes a new ' +
        'top-level bullet, an indented line becomes a child of the line above it - so send nested ' +
        'lines if you want nested bullets. Fails with NOTE_NOT_FOUND rather than creating the ' +
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

  server.registerTool(
    'insert_under_bullet',
    {
      title: 'Insert under a specific bullet',
      description:
        'Add content as new children of a specific EXISTING bullet in an outliner note - unlike ' +
        'append_to_note (which only ever adds at the very end of the file), this places content ' +
        'right where an existing bullet is, after any children it already has. Use this instead of ' +
        'append_to_note whenever a note already has a relevant bullet (e.g. a "[[Project]]" or ' +
        '"Meetings" bullet) and you want to add to it rather than creating a duplicate at the ' +
        'bottom of the note. The bullet is found by a case-insensitive substring match against ' +
        'each bullet\'s own text (its "- " marker and any checkbox are stripped before matching, ' +
        'so matchText like "Project" matches a bullet reading "- [[Project]]" with no special ' +
        'syntax needed). Fails with BULLET_NOT_FOUND if nothing matches, or AMBIGUOUS_MATCH if ' +
        'more than one bullet matches (the error lists every match with its line number and text - ' +
        'retry with a more specific matchText, or pass occurrence to pick one of them). Only works ' +
        'on outliner notes (NOT_OUTLINER_MODE otherwise) and only on a note that already exists ' +
        '(NOTE_NOT_FOUND otherwise - create it first).',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "2026-09-23.md"'),
        matchText: z
          .string()
          .min(1)
          .describe('Case-insensitive substring to find the target bullet by its text.'),
        content: z.string().min(1).max(100_000),
        occurrence: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based index to disambiguate when matchText matches more than one bullet.')
      },
      outputSchema: {
        path: z.string(),
        mode: z.literal('outliner'),
        matchedLine: z.number(),
        matchedText: z.string(),
        appended: z.string()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'insert_under_bullet',
      deps,
      async (
        {
          path: relPath,
          matchText,
          content,
          occurrence
        }: { path: string; matchText: string; content: string; occurrence?: number },
        ctx
      ) => {
        const result = await deps.insertUnderBullet(relPath, matchText, content, ctx, {
          occurrence
        });
        return {
          path: result.path,
          mode: result.mode,
          matchedLine: result.matchedLine,
          matchedText: result.matchedText,
          appended: result.appended
        };
      },
      (args) => args.path
    )
  );
}

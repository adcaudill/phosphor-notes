import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard } from '../toolkit';
import { extractFrontmatter } from '../../../renderer/src/utils/frontmatterUtils';
import { contentHash } from '../../contentHash';
import { getOutline } from '../../../shared/noteSections';
import { InvalidArgumentError } from '../../../shared/noteFormat';

function titleFromPath(relPath: string): string {
  const withoutExt = relPath.replace(/\.md$/i, '');
  return withoutExt.split('/').pop() || withoutExt;
}

export function registerNoteTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List Markdown notes in the vault, optionally scoped to a folder. Returns vault-relative ' +
        'paths (e.g. "People/John.md") suitable for passing to read_note. Only .md files are ' +
        'listed; hidden files/folders (like .phosphor) and .bak backups are excluded.',
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Vault-relative folder to list, e.g. "People". Omit to list the whole vault.'),
        limit: z.number().int().min(1).max(1000).optional().default(200),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous call.')
      },
      outputSchema: {
        notes: z.array(z.object({ path: z.string(), title: z.string(), modified: z.string() })),
        nextCursor: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'list_notes',
      deps,
      async ({ folder, limit, cursor }: { folder?: string; limit?: number; cursor?: string }) => {
        const pageSize = limit ?? 200;
        const notes = await deps.listNotes(folder);
        const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
        const page = notes.slice(offset, offset + pageSize);
        const nextCursor = offset + pageSize < notes.length ? String(offset + pageSize) : undefined;
        return {
          notes: page.map((n) => ({
            path: n.path,
            title: titleFromPath(n.path),
            modified: n.modified
          })),
          nextCursor
        };
      }
    )
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description:
        'Read the full content of one note by its vault-relative path (as returned by ' +
        'list_notes), including its parsed frontmatter. Reads only what is saved to disk - ' +
        'unsaved edits open in the Phosphor Notes editor are not reflected here. Also returns ' +
        '`hash`, an opaque version token for the whole note: pass it back as `expectedHash` to ' +
        'any write tool so the write is refused (NOTE_CHANGED) if the note changed since you read it. ' +
        'For a long note, pass startLine/endLine (1-based, inclusive, counting the whole file ' +
        'including frontmatter - the numbering get_note_outline uses) to read just part of it; ' +
        '`totalLines` tells you how long it is. The hash always covers the whole note.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "People/John.md"'),
        maxChars: z.number().int().min(1).max(500_000).optional().default(100_000),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional()
      },
      outputSchema: {
        path: z.string(),
        title: z.string(),
        frontmatter: z.record(z.string(), z.unknown()).nullable(),
        content: z.string(),
        truncated: z.boolean(),
        hash: z.string(),
        totalLines: z.number(),
        startLine: z.number(),
        endLine: z.number()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'read_note',
      deps,
      async ({
        path: relPath,
        maxChars,
        startLine,
        endLine
      }: {
        path: string;
        maxChars?: number;
        startLine?: number;
        endLine?: number;
      }) => {
        const limit = maxChars ?? 100_000;
        const raw = await deps.readNote(relPath);
        const { frontmatter } = extractFrontmatter(raw);

        const lines = raw.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const totalLines = lines.length;
        const first = startLine ?? 1;
        const last = Math.min(endLine ?? totalLines, totalLines);
        if (first > last && totalLines > 0) {
          throw new InvalidArgumentError(
            `startLine (${first}) must be at or before endLine (${last}); the note has ${totalLines} lines`
          );
        }
        const ranged = startLine !== undefined || endLine !== undefined;
        const selected = ranged ? lines.slice(first - 1, last).join('\n') : raw;
        const truncated = selected.length > limit;

        return {
          path: relPath,
          title: titleFromPath(relPath),
          frontmatter: frontmatter ? frontmatter.content : null,
          content: truncated ? selected.slice(0, limit) : selected,
          truncated,
          hash: contentHash(raw),
          totalLines,
          startLine: first,
          endLine: last
        };
      }
    )
  );

  server.registerTool(
    'get_note_outline',
    {
      title: "Get a note's outline",
      description:
        "List a note's structure: its Markdown headings (freeform notes) or its bullets " +
        '(outliner notes), each with its `line`, `endLine` (the last line of its section), ' +
        '`level`, and `text`. Use it to find a section in a long note without reading the whole ' +
        'thing (then read_note with startLine/endLine), and to get `line` numbers for the section ' +
        'tools. Line numbers count the whole file, frontmatter included. Also returns `hash`, ' +
        'like read_note.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Projects/Plan.md"'),
        limit: z.number().int().min(1).max(5_000).optional().default(1_000)
      },
      outputSchema: {
        path: z.string(),
        mode: z.enum(['freeform', 'outliner']),
        hash: z.string(),
        totalLines: z.number(),
        items: z.array(
          z.object({
            line: z.number(),
            endLine: z.number(),
            level: z.number(),
            kind: z.enum(['heading', 'bullet']),
            text: z.string()
          })
        ),
        truncated: z.boolean()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'get_note_outline',
      deps,
      async ({ path: relPath, limit }: { path: string; limit?: number }) => {
        const raw = await deps.readNote(relPath);
        const outline = getOutline(raw);
        const max = limit ?? 1_000;
        return {
          path: relPath,
          mode: outline.mode,
          hash: contentHash(raw),
          totalLines: outline.totalLines,
          items: outline.items.slice(0, max),
          truncated: outline.items.length > max
        };
      }
    )
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard } from '../toolkit';
import { extractFrontmatter } from '../../../renderer/src/utils/frontmatterUtils';

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
        notes: z.array(
          z.object({ path: z.string(), title: z.string(), modified: z.string() })
        ),
        nextCursor: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'list_notes',
      deps,
      async ({
        folder,
        limit,
        cursor
      }: {
        folder?: string;
        limit?: number;
        cursor?: string;
      }) => {
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
        'unsaved edits open in the Phosphor Notes editor are not reflected here.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "People/John.md"'),
        maxChars: z.number().int().min(1).max(500_000).optional().default(100_000)
      },
      outputSchema: {
        path: z.string(),
        title: z.string(),
        frontmatter: z.record(z.string(), z.unknown()).nullable(),
        content: z.string(),
        truncated: z.boolean()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'read_note',
      deps,
      async ({ path: relPath, maxChars }: { path: string; maxChars?: number }) => {
        const limit = maxChars ?? 100_000;
        const raw = await deps.readNote(relPath);
        const { frontmatter } = extractFrontmatter(raw);
        const truncated = raw.length > limit;
        return {
          path: relPath,
          title: titleFromPath(relPath),
          frontmatter: frontmatter ? frontmatter.content : null,
          content: truncated ? raw.slice(0, limit) : raw,
          truncated
        };
      }
    )
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, withVaultWriteGuard } from '../toolkit';
import { editCommonInput } from './notesEdit';

const versionSchema = z.object({
  id: z.string(),
  ts: z.string(),
  path: z.string(),
  tool: z.string(),
  summary: z.string().optional()
});

/** Read-only views of note history - registered alongside the write tools, since history only ever holds versions that MCP writes replaced. */
export function registerHistoryReadTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_note_versions',
    {
      title: 'List saved versions',
      description:
        'List earlier versions of notes, saved automatically whenever a write tool changed an ' +
        'existing note (newest first; kept for 30 days). Each entry is the content the note had ' +
        "just BEFORE `tool` changed it at `ts`. Pass `path` to see one note's history. Use " +
        "read_note_version to see a version's content, and restore_note_version (if editing is " +
        'enabled) to put it back.',
      inputSchema: {
        path: z.string().optional().describe('Only versions of this vault-relative note.'),
        limit: z.number().int().min(1).max(200).optional().default(20)
      },
      outputSchema: { versions: z.array(versionSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'list_note_versions',
      deps,
      async ({ path: relPath, limit }: { path?: string; limit?: number }) => {
        const versions = await deps.listVersions({ path: relPath, limit: limit ?? 20 });
        return {
          versions: versions.map(({ id, ts, path, tool, summary }) => ({
            id,
            ts,
            path,
            tool,
            summary
          }))
        };
      }
    )
  );

  server.registerTool(
    'read_note_version',
    {
      title: 'Read a saved version',
      description:
        'Read the full content of one saved version (an id from list_note_versions) - what the ' +
        'note contained just before the write that replaced it.',
      inputSchema: {
        id: z.string(),
        maxChars: z.number().int().min(1).max(500_000).optional().default(100_000)
      },
      outputSchema: {
        version: versionSchema,
        content: z.string(),
        truncated: z.boolean()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'read_note_version',
      deps,
      async ({ id, maxChars }: { id: string; maxChars?: number }) => {
        const limit = maxChars ?? 100_000;
        const { entry, text } = await deps.readVersion(id);
        const { id: vid, ts, path, tool, summary } = entry;
        return {
          version: { id: vid, ts, path, tool, summary },
          content: text.length > limit ? text.slice(0, limit) : text,
          truncated: text.length > limit
        };
      }
    )
  );
}

/** Edit tier: replaces a note's current content wholesale. */
export function registerHistoryRestoreTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'restore_note_version',
    {
      title: 'Restore a saved version',
      description:
        "Replace a note's current content with a saved version (an id from list_note_versions), " +
        'e.g. to undo a change. The content being replaced is itself saved as a new version, so ' +
        'a restore can be undone the same way. Recreates the note if it no longer exists. Pass ' +
        "the note's current `hash` (from read_note) as expectedHash to be sure you're not " +
        'discarding a change made since you last looked.',
      inputSchema: {
        id: z.string(),
        expectedHash: z
          .string()
          .optional()
          .describe('The hash read_note last returned for the note being restored.'),
        dryRun: editCommonInput.dryRun
      },
      outputSchema: {
        path: z.string(),
        restoredFrom: z.string(),
        versionId: z.string().optional(),
        created: z.boolean(),
        hash: z.string(),
        dryRun: z.boolean()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'restore_note_version',
      deps,
      async (
        { id, expectedHash, dryRun }: { id: string; expectedHash?: string; dryRun?: boolean },
        ctx
      ) => {
        const result = await deps.restoreVersion(id, ctx, { expectedHash, dryRun });
        return {
          path: result.path,
          restoredFrom: result.restoredFrom,
          versionId: result.versionId,
          created: result.created,
          hash: result.hash,
          dryRun: result.dryRun === true
        };
      },
      undefined,
      { tier: 'edit' }
    )
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultWriteGuard } from '../toolkit';
import { applyTextEdits, type TextEdit } from '../../../shared/textEdits';

/** Inputs every edit-tier tool shares. */
export const editCommonInput = {
  expectedHash: z
    .string()
    .optional()
    .describe(
      'The hash read_note (or get_note_outline) last returned for this note. Strongly recommended: ' +
        'the edit is refused with NOTE_CHANGED if the note changed since.'
    ),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('Show what would change (and the resulting hash) without writing anything.')
};

/** Outputs every edit-tier tool shares. */
export const editCommonOutput = {
  path: z.string(),
  /** Hash of the note after the edit (or what it would be, for a dry run). */
  hash: z.string(),
  changed: z.boolean(),
  dryRun: z.boolean(),
  versionId: z.string().optional()
};

const changeSchema = z.object({
  line: z.number(),
  removed: z.array(z.string()),
  added: z.array(z.string())
});

export function registerNoteEditTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'edit_note',
    {
      title: 'Edit text in a note',
      description:
        'Replace or delete specific existing text anywhere in a note, by exact match. Each edit ' +
        "replaces `oldText` with `newText` (empty newText deletes it). `oldText` must match the note's " +
        'current text exactly - including whitespace and line breaks - and match exactly ONE place ' +
        '(TEXT_NOT_FOUND / AMBIGUOUS_MATCH otherwise; include more surrounding text to pin it ' +
        'down, or set replaceAll). Edits apply in order, each to the result of the previous one, ' +
        'and either all apply or none do. Text is written exactly as given - no outliner ' +
        're-formatting - so match the note\'s existing style (e.g. "- " bullets indented 4 spaces ' +
        'per level in outliner notes). The previous content is saved as a version (versionId), so ' +
        'the edit can be undone with restore_note_version. Returns the changed lines and the new hash.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Projects/Plan.md"'),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).max(100_000),
              newText: z.string().max(100_000),
              replaceAll: z.boolean().optional()
            })
          )
          .min(1)
          .max(50),
        ...editCommonInput
      },
      outputSchema: {
        ...editCommonOutput,
        replacements: z.number(),
        changes: z.array(changeSchema)
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'edit_note',
      deps,
      async (
        {
          path: relPath,
          edits,
          expectedHash,
          dryRun
        }: { path: string; edits: TextEdit[]; expectedHash?: string; dryRun?: boolean },
        ctx
      ) => {
        const result = await deps.modifyNote(
          relPath,
          (doc) => {
            const applied = applyTextEdits(doc, edits);
            return {
              doc: applied.doc,
              meta: { changes: applied.changes, replacements: applied.replacements }
            };
          },
          ctx,
          {
            expectedHash,
            dryRun,
            summary: `${edits.length} edit${edits.length === 1 ? '' : 's'}`
          }
        );
        return {
          path: result.path,
          hash: result.hash,
          changed: result.changed,
          dryRun: result.dryRun,
          versionId: result.versionId,
          replacements: result.meta.replacements,
          changes: result.meta.changes
        };
      },
      (args) => args.path,
      { tier: 'edit' }
    )
  );
}

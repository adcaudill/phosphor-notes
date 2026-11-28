import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultWriteGuard } from '../toolkit';
import { applyTextEdits, type TextEdit } from '../../../shared/textEdits';
import { updateFrontmatter, type FrontmatterEdit } from '../../../shared/frontmatterEdit';
import { extractFrontmatter } from '../../../renderer/src/utils/frontmatterUtils';
import { assertRegionHasNoRedactedValues } from '../redact';

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
        'the edit can be undone with restore_note_version. Returns the changed lines and the new hash. ' +
        'For replaceAll on a name or word, set wholeWord (so "Ann" does not match "Anne") and ' +
        'skipLinks (so existing [[links]] containing it are left alone); only matches that pass ' +
        'those filters count toward uniqueness. Use find_text first to see every occurrence.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Projects/Plan.md"'),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).max(100_000),
              newText: z.string().max(100_000),
              replaceAll: z.boolean().optional(),
              wholeWord: z
                .boolean()
                .optional()
                .describe('Skip matches that are part of a longer word.'),
              skipLinks: z.boolean().optional().describe('Skip matches inside [[wikilinks]].')
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

  server.registerTool(
    'update_frontmatter',
    {
      title: "Update a note's frontmatter",
      description:
        'Change individual frontmatter keys and tags without rewriting the rest of the note: every ' +
        'other frontmatter line and the whole body stay exactly as they are. `set` adds or replaces ' +
        'keys (string, number, boolean, or a list of strings); `remove` deletes keys; `addTags` / ' +
        '`removeTags` edit the tags list (matched case-insensitively; a leading # is ignored). ' +
        'Creates the frontmatter block if the note has none. Values are single-line and quoted ' +
        'automatically where needed. Changing `title` does not rename the file. `mode` ' +
        "(outliner/freeform) can't be changed here, since that wouldn't convert the body.",
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Projects/Plan.md"'),
        set: z
          .record(
            z.string(),
            z.union([z.string().max(2_000), z.number(), z.boolean(), z.array(z.string().max(500))])
          )
          .optional(),
        remove: z.array(z.string()).optional(),
        addTags: z.array(z.string().max(200)).optional(),
        removeTags: z.array(z.string().max(200)).optional(),
        ...editCommonInput
      },
      outputSchema: {
        ...editCommonOutput,
        keysChanged: z.array(z.string()),
        tags: z.array(z.string()),
        frontmatter: z.record(z.string(), z.unknown()).nullable()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'update_frontmatter',
      deps,
      async (
        args: FrontmatterEdit & { path: string; expectedHash?: string; dryRun?: boolean },
        ctx
      ) => {
        const result = await deps.modifyNote(
          args.path,
          (doc) => {
            const edited = updateFrontmatter(doc, args);
            // Don't let a replaced or removed value take a redacted secret with it.
            edited.replacedText.forEach(assertRegionHasNoRedactedValues);
            return { doc: edited.doc, meta: edited };
          },
          ctx,
          { expectedHash: args.expectedHash, dryRun: args.dryRun, summary: 'frontmatter' }
        );
        const { frontmatter } = extractFrontmatter(result.meta.doc);
        return {
          path: result.path,
          hash: result.hash,
          changed: result.changed,
          dryRun: result.dryRun,
          versionId: result.versionId,
          keysChanged: result.meta.keysChanged,
          tags: result.meta.tags,
          frontmatter: frontmatter ? frontmatter.content : null
        };
      },
      (args) => args.path,
      { tier: 'edit' }
    )
  );
}

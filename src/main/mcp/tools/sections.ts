import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultWriteGuard } from '../toolkit';
import { assertRegionHasNoRedactedValues } from '../redact';
import { editCommonInput, editCommonOutput } from './notesEdit';
import { InvalidArgumentError } from '../../../shared/noteFormat';
import {
  replaceSectionBody,
  deleteSection,
  insertAtSection,
  moveSection,
  type SectionLocator,
  type InsertPosition
} from '../../../shared/noteSections';

const SECTION_HELP =
  'A section is a Markdown heading plus everything up to the next heading of the same or higher ' +
  'level (freeform notes), or a bullet plus everything nested under it (outliner notes). Identify ' +
  'it by `match` (case-insensitive substring of the heading/bullet text; add `occurrence` if ' +
  'several match - AMBIGUOUS_MATCH lists them) or by `line` from get_note_outline (requires ' +
  'expectedHash, since line numbers go stale).';

const locatorSchema = z
  .object({
    match: z.string().min(1).optional(),
    occurrence: z.number().int().min(1).optional(),
    line: z.number().int().min(1).optional()
  })
  .describe('Which heading/bullet: { match } (plus optional occurrence), or { line }.');

const positionSchema = z
  .enum(['first_child', 'last_child', 'before', 'after'])
  .describe(
    'first_child / last_child: inside the section, at its start or end (outliner: nested one level ' +
      'deeper). before / after: as a sibling just before the heading/bullet or just after its ' +
      'whole section.'
  );

const sectionOutput = z.object({ line: z.number(), text: z.string() });

/** Line numbers drift as a note changes, so line-based targeting is only allowed against a known version. */
function requireHashForLine(locators: SectionLocator[], expectedHash: string | undefined): void {
  if (expectedHash === undefined && locators.some((l) => l.line !== undefined)) {
    throw new InvalidArgumentError(
      'targeting a section by line requires expectedHash (from read_note or get_note_outline)'
    );
  }
}

interface CommonArgs {
  path: string;
  expectedHash?: string;
  dryRun?: boolean;
}

/** Write tier: only adds content, like insert_under_bullet. */
export function registerSectionInsertTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'insert_at_section',
    {
      title: 'Insert content at a section',
      description:
        'Add new content relative to an existing heading or bullet, in freeform or outliner notes: ' +
        "as the section's first or last child, or just before or after it. " +
        SECTION_HELP +
        ' In an outliner note, content is formatted as bullets at the right depth (relative ' +
        "indentation preserved); in a freeform note it's inserted as written, with blank lines " +
        'around it - include your own subheading if you want one. Never removes anything.',
      inputSchema: {
        path: z.string().describe('Vault-relative path'),
        section: locatorSchema,
        position: positionSchema,
        content: z.string().min(1).max(100_000),
        ...editCommonInput
      },
      outputSchema: {
        ...editCommonOutput,
        section: sectionOutput,
        insertedAtLine: z.number()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'insert_at_section',
      deps,
      async (
        args: CommonArgs & { section: SectionLocator; position: InsertPosition; content: string },
        ctx
      ) => {
        requireHashForLine([args.section], args.expectedHash);
        const result = await deps.modifyNote(
          args.path,
          (doc) => {
            const r = insertAtSection(doc, args.section, args.content, args.position);
            return { doc: r.doc, meta: r };
          },
          ctx,
          { expectedHash: args.expectedHash, dryRun: args.dryRun, summary: args.position }
        );
        return {
          path: result.path,
          hash: result.hash,
          changed: result.changed,
          dryRun: result.dryRun,
          versionId: result.versionId,
          section: result.meta.section,
          insertedAtLine: result.meta.insertedAtLine
        };
      },
      (args) => args.path
    )
  );
}

/** Edit tier: replace, delete, and move change or remove existing text. */
export function registerSectionEditTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'replace_section',
    {
      title: "Replace a section's content",
      description:
        'Replace everything under a heading (including any subsections) or under a bullet (all ' +
        'its nested bullets), keeping the heading/bullet line itself. ' +
        SECTION_HELP +
        ' Outliner content is formatted as bullets nested under it; freeform content is written ' +
        'as given. Empty content clears the section. Refused (REDACTED_CONTENT) if the text being ' +
        'replaced contains a value you were shown redacted. The old content is saved as a version.',
      inputSchema: {
        path: z.string().describe('Vault-relative path'),
        section: locatorSchema,
        content: z.string().max(200_000),
        ...editCommonInput
      },
      outputSchema: { ...editCommonOutput, section: sectionOutput },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'replace_section',
      deps,
      async (args: CommonArgs & { section: SectionLocator; content: string }, ctx) => {
        requireHashForLine([args.section], args.expectedHash);
        const result = await deps.modifyNote(
          args.path,
          (doc) => {
            const r = replaceSectionBody(doc, args.section, args.content);
            assertRegionHasNoRedactedValues(r.removedText ?? '');
            return { doc: r.doc, meta: r };
          },
          ctx,
          { expectedHash: args.expectedHash, dryRun: args.dryRun, summary: 'replace section' }
        );
        return {
          path: result.path,
          hash: result.hash,
          changed: result.changed,
          dryRun: result.dryRun,
          versionId: result.versionId,
          section: result.meta.section
        };
      },
      (args) => args.path,
      { tier: 'edit' }
    )
  );

  server.registerTool(
    'delete_section',
    {
      title: 'Delete a section',
      description:
        'Remove a heading together with its whole section, or a bullet together with everything ' +
        'nested under it. ' +
        SECTION_HELP +
        ' Refused (REDACTED_CONTENT) if the section contains a value you were shown redacted. ' +
        'The old content is saved as a version, so it can be restored.',
      inputSchema: {
        path: z.string().describe('Vault-relative path'),
        section: locatorSchema,
        ...editCommonInput
      },
      outputSchema: { ...editCommonOutput, section: sectionOutput, removedLines: z.number() },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'delete_section',
      deps,
      async (args: CommonArgs & { section: SectionLocator }, ctx) => {
        requireHashForLine([args.section], args.expectedHash);
        const result = await deps.modifyNote(
          args.path,
          (doc) => {
            const r = deleteSection(doc, args.section);
            assertRegionHasNoRedactedValues(r.removedText ?? '');
            return { doc: r.doc, meta: r };
          },
          ctx,
          { expectedHash: args.expectedHash, dryRun: args.dryRun, summary: 'delete section' }
        );
        return {
          path: result.path,
          hash: result.hash,
          changed: result.changed,
          dryRun: result.dryRun,
          versionId: result.versionId,
          section: result.meta.section,
          removedLines: (result.meta.removedText ?? '').split('\n').length
        };
      },
      (args) => args.path,
      { tier: 'edit' }
    )
  );

  server.registerTool(
    'move_section',
    {
      title: 'Move a section',
      description:
        'Move a section (heading + its content, or bullet + everything nested under it) to another ' +
        'place in the same note, relative to a target section. ' +
        SECTION_HELP +
        ' The moved section is re-levelled to fit where it lands: bullets are re-indented; heading ' +
        "levels shift (refused if that would need deeper than ######). The target can't be the " +
        'section itself or inside it. Nothing is removed from the note.',
      inputSchema: {
        path: z.string().describe('Vault-relative path'),
        section: locatorSchema.describe('The section to move.'),
        target: locatorSchema.describe('The section to place it relative to.'),
        position: positionSchema,
        ...editCommonInput
      },
      outputSchema: {
        ...editCommonOutput,
        section: sectionOutput,
        target: sectionOutput,
        movedToLine: z.number()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'move_section',
      deps,
      async (
        args: CommonArgs & {
          section: SectionLocator;
          target: SectionLocator;
          position: InsertPosition;
        },
        ctx
      ) => {
        requireHashForLine([args.section, args.target], args.expectedHash);
        const result = await deps.modifyNote(
          args.path,
          (doc) => {
            const r = moveSection(doc, args.section, args.target, args.position);
            return { doc: r.doc, meta: r };
          },
          ctx,
          { expectedHash: args.expectedHash, dryRun: args.dryRun, summary: 'move section' }
        );
        return {
          path: result.path,
          hash: result.hash,
          changed: result.changed,
          dryRun: result.dryRun,
          versionId: result.versionId,
          section: result.meta.section,
          target: result.meta.target,
          movedToLine: result.meta.movedToLine
        };
      },
      (args) => args.path,
      { tier: 'edit' }
    )
  );
}

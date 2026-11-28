import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, withVaultWriteGuard, IndexNotReadyError } from '../toolkit';
import { editCommonInput } from './notesEdit';
import { contentHash } from '../../contentHash';
import { extractFrontmatter } from '../../../renderer/src/utils/frontmatterUtils';
import { InvalidArgumentError } from '../../../shared/noteFormat';

export class NoteHasBacklinksError extends Error {
  constructor(
    public readonly relPath: string,
    public readonly backlinks: string[]
  ) {
    super(
      `${backlinks.length} note${backlinks.length === 1 ? ' links' : 's link'} to ${relPath} ` +
        `(${backlinks.slice(0, 10).join(', ')}${backlinks.length > 10 ? ', ...' : ''}), and those ` +
        'links would break. Confirm with the user, then pass force: true to delete it anyway.'
    );
    this.name = 'NoteHasBacklinksError';
  }
}

const DAILY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Shifts a YYYY-MM-DD date by whole days (calendar arithmetic, immune to DST). */
function shiftDate(ymd: string, days: number): string {
  const [, y, m, d] = DAILY_RE.exec(ymd)!;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + days));
  return date.toISOString().slice(0, 10);
}

/** Resolves "today" / "yesterday" / "tomorrow" / YYYY-MM-DD against today's date. */
export function resolveDailyNoteDate(input: string, today: string): string {
  const value = input.trim().toLowerCase();
  if (value === 'today') return today;
  if (value === 'yesterday') return shiftDate(today, -1);
  if (value === 'tomorrow') return shiftDate(today, 1);
  const m = DAILY_RE.exec(value);
  if (m && shiftDate(value, 0) === value) return value;
  throw new InvalidArgumentError(
    'date must be "today", "yesterday", "tomorrow", or a real date as YYYY-MM-DD'
  );
}

/** Read tier: the daily journal note for a date. */
export function registerDailyNoteTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'get_daily_note',
    {
      title: 'Get a daily note',
      description:
        'Read the user\'s daily journal note for a date - "today" (the default), "yesterday", ' +
        '"tomorrow", or YYYY-MM-DD. "today" is the date on the computer running Phosphor Notes, so ' +
        "you don't have to guess the user's timezone. Daily notes are YYYY-MM-DD.md at the top of " +
        'the vault. If there is no note for that date yet, `exists` is false and there is no ' +
        'content - that just means nothing has been written that day. Returns `hash` like read_note.',
      inputSchema: {
        date: z.string().optional().default('today')
      },
      outputSchema: {
        date: z.string(),
        path: z.string(),
        exists: z.boolean(),
        content: z.string().optional(),
        frontmatter: z.record(z.string(), z.unknown()).nullable().optional(),
        hash: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard('get_daily_note', deps, async ({ date }: { date?: string }) => {
      const today = deps.todayDailyNotePath().replace(/\.md$/, '');
      const resolved = resolveDailyNoteDate(date ?? 'today', today);
      const notePath = `${resolved}.md`;
      let raw: string;
      try {
        raw = await deps.readNote(notePath);
      } catch (err) {
        if (err instanceof Error && err.name === 'NoteNotFoundError') {
          return { date: resolved, path: notePath, exists: false };
        }
        throw err;
      }
      const { frontmatter } = extractFrontmatter(raw);
      return {
        date: resolved,
        path: notePath,
        exists: true,
        content: raw,
        frontmatter: frontmatter ? frontmatter.content : null,
        hash: contentHash(raw)
      };
    })
  );
}

/** Organize tier: rename/move a note. */
export function registerMoveNoteTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'move_note',
    {
      title: 'Rename or move a note',
      description:
        'Rename a note and/or move it to another folder (`to` is the full new vault-relative path, ' +
        'e.g. "Archive/2026/Plan.md"), and update every [[link]] to it across the vault - aliases ' +
        'and #headings are kept. Never overwrites: refused (NOTE_ALREADY_EXISTS) if `to` exists. ' +
        'If the note has child notes (e.g. People.md and People/...), you get HAS_CHILD_NOTES: pass ' +
        'includeChildren to move the whole subtree with it (links to the children are updated ' +
        'too). Refused (PATH_NOT_IN_WRITE_SCOPE / NOTE_HAS_UNSAVED_EDITS) if the note, its ' +
        'destination, or any note whose links would change is outside the allowed folders or open ' +
        'with unsaved edits. Use dryRun to see which notes would change. The rename is recorded in ' +
        'note history (versionId), and restore_note_version with that id moves it back.',
      inputSchema: {
        from: z.string().describe('Current vault-relative path, e.g. "Inbox/Idea.md"'),
        to: z.string().describe('New vault-relative path, e.g. "Projects/Idea.md"'),
        includeChildren: z.boolean().optional(),
        ...editCommonInput
      },
      outputSchema: {
        from: z.string(),
        to: z.string(),
        movedChildren: z.array(z.object({ from: z.string(), to: z.string() })),
        linksUpdated: z.array(z.object({ path: z.string(), links: z.number() })),
        linksFailed: z.array(z.object({ path: z.string(), error: z.string() })),
        parentsCreated: z.array(z.string()),
        versionId: z.string().optional(),
        dryRun: z.boolean()
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }
    },
    withVaultWriteGuard(
      'move_note',
      deps,
      async (
        args: {
          from: string;
          to: string;
          includeChildren?: boolean;
          expectedHash?: string;
          dryRun?: boolean;
        },
        ctx
      ) => {
        const result = await deps.moveNote(args.from, args.to, ctx, {
          includeChildren: args.includeChildren,
          expectedHash: args.expectedHash,
          dryRun: args.dryRun
        });
        return {
          from: result.from,
          to: result.to,
          movedChildren: result.movedChildren.map(([from, to]) => ({ from, to })),
          linksUpdated: result.linksUpdated,
          linksFailed: result.linksFailed,
          parentsCreated: result.parentsCreated,
          versionId: result.versionId,
          dryRun: result.dryRun === true
        };
      },
      (args) => args.from,
      { tier: 'organize' }
    )
  );
}

/** Delete tier: delete a note. */
export function registerDeleteNoteTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'delete_note',
    {
      title: 'Delete a note',
      description:
        'Delete a note. It goes to the system Trash, and its content is saved as a version first ' +
        '(versionId) so restore_note_version can bring it back. Refused (HAS_BACKLINKS) if other ' +
        'notes link to it - their links would break - unless you pass force: true, which you ' +
        'should only do once the user has confirmed. Child notes (People/... for People.md) count ' +
        'as linking to it and are never deleted with it. Confirm with the user before deleting ' +
        "anything they didn't explicitly ask to delete.",
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Inbox/Old.md"'),
        force: z
          .boolean()
          .optional()
          .describe('Delete even though other notes link to it (their links will break).'),
        ...editCommonInput
      },
      outputSchema: {
        path: z.string(),
        versionId: z.string().optional(),
        dryRun: z.boolean(),
        brokenLinksIn: z.array(z.string())
      },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
    },
    withVaultWriteGuard(
      'delete_note',
      deps,
      async (
        args: { path: string; force?: boolean; expectedHash?: string; dryRun?: boolean },
        ctx
      ) => {
        const backlinks = deps.findBacklinks(args.path);
        if (backlinks === null) throw new IndexNotReadyError();
        if (backlinks.length > 0 && !args.force) {
          throw new NoteHasBacklinksError(args.path, backlinks);
        }
        const result = await deps.deleteNote(args.path, ctx, {
          expectedHash: args.expectedHash,
          dryRun: args.dryRun
        });
        return {
          path: result.path,
          versionId: result.versionId,
          dryRun: result.dryRun === true,
          brokenLinksIn: backlinks
        };
      },
      (args) => args.path,
      { tier: 'delete' }
    )
  );
}

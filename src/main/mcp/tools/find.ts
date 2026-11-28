import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, errorCodeFor } from '../toolkit';
import { contentHash } from '../../contentHash';
import { extractFrontmatter } from '../../../renderer/src/utils/frontmatterUtils';
import { findOccurrences, wikilinkSpans, overlapsAny } from '../../../shared/textMatch';

const MAX_LINE_CHARS = 300;

/** Read tools for working across many notes at once: exact search and batch reads. */
export function registerFindTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'find_text',
    {
      title: 'Find exact text',
      description:
        'Find every occurrence of an exact piece of text across the vault (or one folder), with ' +
        'the path, line number, and line for each match. Unlike search_notes (fuzzy, ranked, max 20 ' +
        'notes), this is a literal match that reads the notes as they are on disk right now - use it ' +
        'to answer "where does X appear?", to check a fix left no occurrences behind (an empty ' +
        'result with truncated: false means there are none), or to find which note holds a value ' +
        'like an email address. Case-insensitive unless caseSensitive. wholeWord skips matches ' +
        'inside longer words. Each match says whether it is inside a [[wikilink]]; inLinks ' +
        '"only" / "exclude" filters on that. Line numbers count the whole file, like read_note.',
      inputSchema: {
        query: z.string().min(1).max(500),
        caseSensitive: z.boolean().optional().default(false),
        wholeWord: z.boolean().optional().default(false),
        inLinks: z.enum(['any', 'only', 'exclude']).optional().default('any'),
        folder: z.string().optional().describe('Only search notes in this vault-relative folder.'),
        maxResults: z.number().int().min(1).max(2000).optional().default(200)
      },
      outputSchema: {
        matches: z.array(
          z.object({
            path: z.string(),
            line: z.number(),
            column: z.number(),
            text: z.string(),
            inLink: z.boolean()
          })
        ),
        totalMatches: z.number(),
        notesWithMatches: z.number(),
        notesSearched: z.number(),
        truncated: z.boolean(),
        unreadable: z.array(z.object({ path: z.string(), error: z.string() }))
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'find_text',
      deps,
      async (args: {
        query: string;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        inLinks?: 'any' | 'only' | 'exclude';
        folder?: string;
        maxResults?: number;
      }) => {
        const max = args.maxResults ?? 200;
        const inLinks = args.inLinks ?? 'any';
        const notes = await deps.listNotes(args.folder);
        const matches: Array<{
          path: string;
          line: number;
          column: number;
          text: string;
          inLink: boolean;
        }> = [];
        const unreadable: Array<{ path: string; error: string }> = [];
        let totalMatches = 0;
        let notesWithMatches = 0;

        for (const note of notes) {
          let text: string;
          try {
            text = await deps.readNote(note.path);
          } catch (err) {
            unreadable.push({ path: note.path, error: errorCodeFor(err) });
            continue;
          }
          let noteHadMatch = false;
          const lines = text.split('\n');
          lines.forEach((line, i) => {
            const spans = wikilinkSpans(line);
            for (const col of findOccurrences(line, args.query, {
              caseSensitive: args.caseSensitive === true,
              wholeWord: args.wholeWord === true
            })) {
              const inLink = overlapsAny(col, args.query.length, spans);
              if ((inLinks === 'only' && !inLink) || (inLinks === 'exclude' && inLink)) continue;
              totalMatches++;
              noteHadMatch = true;
              if (matches.length < max) {
                matches.push({
                  path: note.path,
                  line: i + 1,
                  column: col + 1,
                  text: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line,
                  inLink
                });
              }
            }
          });
          if (noteHadMatch) notesWithMatches++;
        }

        return {
          matches,
          totalMatches,
          notesWithMatches,
          notesSearched: notes.length - unreadable.length,
          truncated: totalMatches > matches.length,
          unreadable
        };
      }
    )
  );

  server.registerTool(
    'read_notes',
    {
      title: 'Read several notes',
      description:
        'Read up to 25 notes in one call - the batch form of read_note. Each result has the same ' +
        'fields as read_note (content, frontmatter, hash), or an `error` code (e.g. NOTE_NOT_FOUND) for ' +
        'a path that could not be read; one bad path does not fail the others. Content is capped ' +
        'per note by maxCharsPerNote.',
      inputSchema: {
        paths: z.array(z.string()).min(1).max(25),
        maxCharsPerNote: z.number().int().min(1).max(100_000).optional().default(20_000)
      },
      outputSchema: {
        notes: z.array(
          z.object({
            path: z.string(),
            content: z.string().optional(),
            frontmatter: z.record(z.string(), z.unknown()).nullable().optional(),
            truncated: z.boolean().optional(),
            hash: z.string().optional(),
            error: z.string().optional()
          })
        )
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'read_notes',
      deps,
      async ({ paths, maxCharsPerNote }: { paths: string[]; maxCharsPerNote?: number }) => {
        const limit = maxCharsPerNote ?? 20_000;
        const notes: Array<{
          path: string;
          content?: string;
          frontmatter?: Record<string, unknown> | null;
          truncated?: boolean;
          hash?: string;
          error?: string;
        }> = [];
        for (const relPath of [...new Set(paths)]) {
          try {
            const raw = await deps.readNote(relPath);
            const { frontmatter } = extractFrontmatter(raw);
            notes.push({
              path: relPath,
              content: raw.length > limit ? raw.slice(0, limit) : raw,
              frontmatter: frontmatter ? frontmatter.content : null,
              truncated: raw.length > limit,
              hash: contentHash(raw)
            });
          } catch (err) {
            notes.push({ path: relPath, error: errorCodeFor(err) });
          }
        }
        return { notes };
      }
    )
  );
}

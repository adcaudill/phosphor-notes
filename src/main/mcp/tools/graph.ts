import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, IndexNotReadyError } from '../toolkit';
import { getBacklinks, getGraphStats, findIsolatedFiles } from '../../graphBuilder';

export function registerGraphTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'get_note_links',
    {
      title: 'Get a note’s links',
      description:
        'Get the outgoing wikilinks from a note and the backlinks pointing to it (from the vault’s ' +
        'graph). Pass the same vault-relative path used with read_note. Also works for a page that ' +
        'does not exist yet but is linked to (`exists: false`, no outgoing links) - e.g. to find ' +
        'every note linking to a misspelled or not-yet-created page. See list_unresolved_links.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "People/John.md"')
      },
      outputSchema: {
        path: z.string(),
        exists: z.boolean(),
        outgoing: z.array(z.string()),
        backlinks: z.array(z.string())
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard('get_note_links', deps, async ({ path: relPath }: { path: string }) => {
      const graph = deps.getGraph();
      if (graph === null) {
        throw new IndexNotReadyError();
      }
      const outgoing = graph[relPath];
      const backlinks = getBacklinks(graph, relPath);
      if (outgoing === undefined && backlinks.length === 0) {
        const err = new Error(
          `No note or link target ${relPath} (is it a real note in the vault?)`
        );
        err.name = 'NoteNotFoundError';
        throw err;
      }
      return {
        path: relPath,
        exists: outgoing !== undefined,
        outgoing: outgoing ?? [],
        backlinks
      };
    })
  );

  server.registerTool(
    'get_graph_stats',
    {
      title: 'Get graph stats',
      description:
        'Vault-wide link graph statistics: file/link counts, isolated notes, cycles, and the most-linked-to notes.',
      inputSchema: {
        includeIsolated: z.boolean().optional().default(false)
      },
      outputSchema: {
        totalFiles: z.number(),
        totalLinks: z.number(),
        avgLinksPerFile: z.number(),
        isolatedFiles: z.number(),
        cycles: z.number(),
        mostLinked: z.array(z.object({ file: z.string(), backlinks: z.number() })),
        isolated: z.array(z.string()).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'get_graph_stats',
      deps,
      async ({ includeIsolated }: { includeIsolated?: boolean }) => {
        const graph = deps.getGraph();
        if (graph === null) {
          throw new IndexNotReadyError();
        }
        const stats = getGraphStats(graph);
        return {
          ...stats,
          isolated: includeIsolated ? findIsolatedFiles(graph) : undefined
        };
      }
    )
  );

  server.registerTool(
    'list_unresolved_links',
    {
      title: 'List unresolved links',
      description:
        'List every [[link]] target that has no note, with the notes that link to it - broken ' +
        "links, misspellings, links in the wrong form (e.g. an email address instead of a person's " +
        "page), and pages that are simply waiting to be created. The calendar's virtual date nodes " +
        "and a nested note's implicit link to its parent are not included. Pass folder to only " +
        'consider links from notes in that folder.',
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Only links from notes in this vault-relative folder.'),
        limit: z.number().int().min(1).max(2000).optional().default(500)
      },
      outputSchema: {
        unresolved: z.array(z.object({ target: z.string(), linkedFrom: z.array(z.string()) })),
        total: z.number(),
        truncated: z.boolean()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'list_unresolved_links',
      deps,
      async ({ folder, limit }: { folder?: string; limit?: number }) => {
        const graph = deps.getGraph();
        if (graph === null) throw new IndexNotReadyError();
        const existing = new Set((await deps.listNotes()).map((n) => n.path));
        const prefix = folder ? folder.replace(/\/+$/, '') + '/' : null;
        const byTarget = new Map<string, Set<string>>();

        for (const [source, links] of Object.entries(graph)) {
          if (!existing.has(source)) continue; // virtual date nodes and other non-notes
          if (prefix && !source.startsWith(prefix)) continue;
          for (const target of links) {
            if (existing.has(target)) continue;
            if (/^\d{4}(-\d{2})?\.md$/.test(target)) continue; // virtual year/month nodes
            // A nested note implicitly links to each parent (People/John.md -> People.md).
            if (source.startsWith(target.replace(/\.md$/i, '') + '/')) continue;
            if (!byTarget.has(target)) byTarget.set(target, new Set());
            byTarget.get(target)!.add(source);
          }
        }

        const all = [...byTarget.entries()]
          .map(([target, from]) => ({ target, linkedFrom: [...from].sort() }))
          .sort((a, b) => a.target.localeCompare(b.target));
        const max = limit ?? 500;
        return { unresolved: all.slice(0, max), total: all.length, truncated: all.length > max };
      }
    )
  );
}

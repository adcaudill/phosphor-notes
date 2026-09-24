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
        'graph). Pass the same vault-relative path used with read_note.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "People/John.md"')
      },
      outputSchema: {
        path: z.string(),
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
      if (outgoing === undefined) {
        const err = new Error(`No graph entry for ${relPath} (is it a real note in the vault?)`);
        err.name = 'NoteNotFoundError';
        throw err;
      }
      return {
        path: relPath,
        outgoing,
        backlinks: getBacklinks(graph, relPath)
      };
    })
  );

  server.registerTool(
    'get_graph_stats',
    {
      title: 'Get graph stats',
      description: 'Vault-wide link graph statistics: file/link counts, isolated notes, cycles, and the most-linked-to notes.',
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
}

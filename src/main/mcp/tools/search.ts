import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard, IndexNotReadyError } from '../toolkit';

interface RawSearchResult {
  filename?: unknown;
  title?: unknown;
  snippet?: unknown;
}

export function registerSearchTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Full-text search across every note in the vault. Returns matching notes with a short ' +
        'snippet of the matching content; pass the returned `path` to read_note for the full text.',
      inputSchema: {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(20).optional().default(10)
      },
      outputSchema: {
        results: z.array(
          z.object({ path: z.string(), title: z.string(), snippet: z.string().optional() })
        )
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'search_notes',
      deps,
      async ({ query, limit }: { query: string; limit?: number }) => {
        if (!deps.isIndexReady()) {
          throw new IndexNotReadyError();
        }
        const raw = (await deps.searchNotes(query)) as RawSearchResult[];
        const results = raw.slice(0, limit ?? 10).map((r) => ({
          path: String(r.filename ?? ''),
          title: String(r.title ?? ''),
          snippet: typeof r.snippet === 'string' ? r.snippet : undefined
        }));
        return { results };
      }
    )
  );
}

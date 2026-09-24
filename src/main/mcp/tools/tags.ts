import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from '../deps';
import { withVaultGuard } from '../toolkit';
import { extractTags } from '../../graphBuilder';

interface CacheEntry {
  mtimeMs: number;
  tags: string[];
}

// Cache tag extraction per-note by mtime, invalidated whenever the vault's
// generation changes (lock/unlock/switch/close), since there is no
// dedicated tag index in the app today - tags are computed on demand by
// reading every note's frontmatter.
let cache = new Map<string, CacheEntry>();
let cacheGeneration = -1;

async function getTagsByNote(deps: McpDeps): Promise<Map<string, string[]>> {
  const generation = deps.getGeneration();
  if (generation !== cacheGeneration) {
    cache = new Map();
    cacheGeneration = generation;
  }

  const notes = await deps.listNotes();
  const result = new Map<string, string[]>();
  for (const note of notes) {
    const mtimeMs = new Date(note.modified).getTime();
    const cached = cache.get(note.path);
    if (cached && cached.mtimeMs === mtimeMs) {
      result.set(note.path, cached.tags);
      continue;
    }
    try {
      const content = await deps.readNote(note.path);
      const tags = extractTags(content);
      cache.set(note.path, { mtimeMs, tags });
      result.set(note.path, tags);
    } catch {
      // Skip notes that fail to decrypt/read rather than failing the whole listing.
    }
  }
  return result;
}

function titleFromPath(relPath: string): string {
  const withoutExt = relPath.replace(/\.md$/i, '');
  return withoutExt.split('/').pop() || withoutExt;
}

export function registerTagTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'List all frontmatter tags used across the vault, with how many notes use each. Only ' +
        'tags declared in frontmatter are included, not inline #hashtags in note bodies.',
      outputSchema: {
        tags: z.array(z.object({ tag: z.string(), count: z.number() }))
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard('list_tags', deps, async () => {
      const byNote = await getTagsByNote(deps);
      const counts = new Map<string, number>();
      for (const tags of byNote.values()) {
        for (const tag of tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      const tags = Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      return { tags };
    })
  );

  server.registerTool(
    'find_notes_by_tag',
    {
      title: 'Find notes by tag',
      description: 'List notes whose frontmatter declares the given tag (matched case-insensitively).',
      inputSchema: {
        tag: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional().default(200)
      },
      outputSchema: {
        notes: z.array(z.object({ path: z.string(), title: z.string() }))
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    withVaultGuard(
      'find_notes_by_tag',
      deps,
      async ({ tag, limit }: { tag: string; limit?: number }) => {
        const needle = tag.trim().toLowerCase();
        const byNote = await getTagsByNote(deps);
        const notes = Array.from(byNote.entries())
          .filter(([, tags]) => tags.includes(needle))
          .map(([path]) => ({ path, title: titleFromPath(path) }))
          .slice(0, limit ?? 200);
        return { notes };
      }
    )
  );
}

import { parentPort } from 'worker_threads';
import { extractWikilinks, getImplicitPathLinks } from '../../shared/wikilinks';

// MiniSearch can have import issues in worker context
// Load it dynamically to handle both ESM and CommonJS contexts
let MiniSearch: unknown = null;

// Dynamically import minisearch to avoid require() in ESM contexts
(async () => {
  try {
    const imported = await import('minisearch');
    if (typeof imported === 'object' && imported !== null && 'default' in imported) {
      // ESM default export
      MiniSearch = (imported as { default: unknown }).default;
    } else {
      // CommonJS or other shape
      MiniSearch = imported;
    }
  } catch {
    // Fallback: if dynamic import fails, leave MiniSearch null
    MiniSearch = null;
  }
})();

type Graph = Record<string, string[]>;

export interface Task {
  file: string;
  line: number;
  status: 'todo' | 'doing' | 'done';
  text: string;
  dueDate?: string; // ISO date string (YYYY-MM-DD)
  completedAt?: string; // ISO datetime string (YYYY-MM-DD HH:MM:SS)
}

// Minimal interface for the subset of MiniSearch used by this worker
interface SearchEngine {
  search(query: string, options?: Record<string, unknown>): Array<Record<string, unknown>>;
  add(doc: Record<string, unknown>): void;
}

let searchEngine: SearchEngine | null = null;

/**
 * Extract tags from YAML frontmatter
 * Supports multiple formats:
 * 1. tags: [tag1, tag2, tag3]
 * 2. tags: tag1, tag2, tag3
 * 3. #tag1 #tag2 in frontmatter
 */
function extractTags(content: string): string[] {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return [];

  const frontmatter = frontmatterMatch[1];
  const tags = new Set<string>();

  // Format 1: tags: [tag1, tag2, tag3]
  const arrayMatch = frontmatter.match(/tags:\s*\[(.*?)\]/);
  if (arrayMatch) {
    const tagList = arrayMatch[1].split(',').map((t) => t.trim().toLowerCase());
    tagList.forEach((t) => tags.add(t));
  }

  // Format 2: tags: tag1, tag2, tag3 (comma-separated)
  if (!arrayMatch) {
    const csvMatch = frontmatter.match(/tags:\s*([^\n]+)/);
    if (csvMatch) {
      const tagList = csvMatch[1].split(',').map((t) => t.trim().toLowerCase());
      tagList.forEach((t) => tags.add(t));
    }
  }

  // Format 3: #tag1 #tag2 (hashtag format)
  const hashtagMatches = frontmatter.matchAll(/#(\w+)/g);
  for (const match of hashtagMatches) {
    tags.add(match[1].toLowerCase());
  }

  return Array.from(tags).sort();
}

// Extract tasks from markdown content
function extractTasks(content: string, filename: string): Task[] {
  const tasks: Task[] = [];
  const taskRegex = /^\s*-\s*\[([ x/])\]\s*(.*)$/gm;

  let match;
  while ((match = taskRegex.exec(content)) !== null) {
    const status = match[1] === ' ' ? 'todo' : match[1] === '/' ? 'doing' : 'done';
    const text = match[2].trim();
    // Calculate line number (1-indexed)
    const line = content.substring(0, match.index).split('\n').length;

    // Extract due date from task text
    let dueDate: string | undefined;

    // Try Phosphor @-notation style: @due(YYYY-MM-DD)
    const atDueMatch = text.match(/@due\((\d{4}-\d{2}-\d{2})\)/);
    if (atDueMatch) {
      dueDate = atDueMatch[1];
    }

    // Try emoji style: 📅 YYYY-MM-DD
    if (!dueDate) {
      const emojiDateMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
      if (emojiDateMatch) {
        dueDate = emojiDateMatch[1];
      }
    }

    // Try Org-mode style: DEADLINE: <YYYY-MM-DD ...>
    if (!dueDate) {
      const orgDateMatch = text.match(/DEADLINE:\s*<(\d{4}-\d{2}-\d{2})/i);
      if (orgDateMatch) {
        dueDate = orgDateMatch[1];
      }
    }

    // Extract completion timestamp from task text
    let completedAt: string | undefined;
    const completeMatch = text.match(/✓\s*(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
    if (completeMatch) {
      completedAt = completeMatch[1];
    }

    tasks.push({
      file: filename,
      line,
      status,
      text,
      dueDate,
      completedAt
    });
  }

  return tasks;
}

/**
 * Check if a filename matches the daily note pattern (YYYY-MM-DD.md)
 */
function isDailyNote(filename: string): boolean {
  return /(\d{4})-(\d{2})-(\d{2})\.md$/.test(filename);
}

/**
 * Extract year-month and year from daily note filename
 * Returns { year: '2026', month: '2026-01' } for '2026-01-13.md'
 */
function extractDateHierarchy(filename: string): { year: string; month: string } | null {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (!match) return null;

  const [, year, month] = match;
  return {
    year: `${year}.md`,
    month: `${year}-${month}.md`
  };
}

/**
 * Generate virtual temporal nodes from daily notes in the file list
 * Creates year and month virtual nodes that connect daily notes hierarchically
 */
function generateVirtualTemporalNodes(files: string[]): Graph {
  const virtualGraph: Graph = {};
  const yearNodes = new Set<string>();
  const monthNodes = new Set<string>();
  const monthToYear = new Map<string, string>();

  // Collect all year and month nodes from daily notes
  for (const file of files) {
    if (isDailyNote(file)) {
      const hierarchy = extractDateHierarchy(file);
      if (hierarchy) {
        yearNodes.add(hierarchy.year);
        monthNodes.add(hierarchy.month);
        monthToYear.set(hierarchy.month, hierarchy.year);
      }
    }
  }

  // Create year nodes that link to their months
  const monthsByYear = new Map<string, Set<string>>();
  for (const [month, year] of monthToYear.entries()) {
    if (!monthsByYear.has(year)) {
      monthsByYear.set(year, new Set());
    }
    monthsByYear.get(year)!.add(month);
  }

  for (const [year, months] of monthsByYear.entries()) {
    virtualGraph[year] = Array.from(months).sort();
  }

  // Create month nodes that link to their daily notes
  for (const file of files) {
    if (isDailyNote(file)) {
      const hierarchy = extractDateHierarchy(file);
      if (hierarchy) {
        if (!virtualGraph[hierarchy.month]) {
          virtualGraph[hierarchy.month] = [];
        }
        virtualGraph[hierarchy.month].push(file);
        virtualGraph[hierarchy.month].sort();
      }
    }
  }

  return virtualGraph;
}

// Initialize MiniSearch
const initSearch = (): void => {
  if (!MiniSearch) {
    searchEngine = null;
    return;
  }

  // Cast the dynamically imported MiniSearch to a constructor that produces our SearchEngine
  const MiniSearchCtor = MiniSearch as unknown as {
    new (options?: Record<string, unknown>): SearchEngine;
  };

  searchEngine = new MiniSearchCtor({
    fields: ['title', 'content', 'tags'],
    storeFields: ['title', 'filename', 'tags', 'content'],
    searchOptions: {
      boost: { title: 2, tags: 1.5 },
      fuzzy: 0.2
    }
  });
};

// Splits a query the same simple way MiniSearch's default tokenizer does
// (non-word-character boundaries), for finding a snippet line that actually
// contains something the search matched on - not necessarily the full
// literal query string, since the engine itself matches per-token.
// Exported for direct unit testing (see worker/__tests__/indexer.snippet.test.ts).
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// Strips a leading YAML-ish frontmatter block (same pattern as extractTags
// above), so snippet generation never picks the frontmatter delimiter line
// itself - "---" is non-blank, so without this it would otherwise "win" the
// first-non-blank-line fallback for nearly every note.
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

parentPort?.on(
  'message',
  async (
    msg:
      | string
      | { type: string; query: string; requestId?: string; combineWith?: 'OR' | 'AND' }
      | { vaultPath?: string; masterKey?: string }
  ) => {
    // Handle search queries
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg as { type?: unknown }).type === 'search'
    ) {
      const searchMsg = msg as {
        type: 'search';
        query: string;
        requestId?: string;
        combineWith?: 'OR' | 'AND';
      };
      if (!searchEngine) {
        // Return empty results if search engine not ready yet
        parentPort?.postMessage({
          type: 'search-results',
          data: [],
          requestId: searchMsg.requestId
        });
        return;
      }
      const results = searchEngine.search(searchMsg.query, {
        prefix: true,
        combineWith: searchMsg.combineWith ?? 'OR'
      });

      const tokens = queryTokens(searchMsg.query);

      // Generate snippets from content
      const resultsWithSnippets = results.slice(0, 20).map((result: Record<string, unknown>) => {
        const rawContent = typeof result.content === 'string' ? result.content : '';
        const content = stripFrontmatter(rawContent);
        const lines = content.split('\n').filter((line) => line.trim().length > 0);
        let snippet = '';

        // Prefer a line containing the literal full query string...
        for (const line of lines) {
          if (line.toLowerCase().includes(searchMsg.query.toLowerCase())) {
            snippet = line.substring(0, 120).trim();
            if (snippet.length === 120) snippet += '…';
            break;
          }
        }

        // ...otherwise, a line containing any token the query actually
        // matched on (the common case: the engine matched per-token, so no
        // single line necessarily contains the full literal query).
        if (!snippet && tokens.length > 0) {
          for (const line of lines) {
            const lower = line.toLowerCase();
            if (tokens.some((t) => lower.includes(t))) {
              snippet = line.substring(0, 120).trim();
              if (snippet.length === 120) snippet += '…';
              break;
            }
          }
        }

        // Last resort: first non-blank body line (frontmatter already stripped).
        if (!snippet && lines.length > 0) {
          snippet = lines[0].substring(0, 120).trim();
          if (snippet.length === 120) snippet += '…';
        }

        return {
          id: result.id,
          title: result.title,
          filename: result.filename,
          snippet: snippet
        };
      });

      parentPort?.postMessage({
        type: 'search-results',
        data: resultsWithSnippets,
        requestId: searchMsg.requestId
      });
      return;
    }

    // Handle initial indexing - msg is an array of { filename, content } objects
    if (!Array.isArray(msg)) {
      return;
    }

    const fileContents = msg as Array<{ filename: string; content: string }>;
    try {
      console.log('[IndexerWorker] received batch:', fileContents.length);
    } catch {
      // ignore log errors
    }
    const graph: Graph = {};
    const tasks: Task[] = [];
    initSearch();

    try {
      await Promise.all(
        fileContents.map(async (file) => {
          try {
            const { filename, content } = file;

            // Extract wikilinks from content
            const links = extractWikilinks(content);

            // Also add implicit links from the file's own nested path
            // e.g., if file is "People/John.md", it implicitly links to "People.md"
            const implicitLinks = getImplicitPathLinks(filename);
            const allLinks = [...links, ...implicitLinks];

            // Deduplicate links (preserve insertion order) so multiple wikilinks
            // to the same target only create a single graph edge.
            const uniqueLinks = Array.from(new Set(allLinks));

            graph[filename] = uniqueLinks;
            for (const target of uniqueLinks) {
              if (!graph[target]) graph[target] = [];
            }

            // Extract tasks from this file
            const fileTasks = extractTasks(content, filename);
            tasks.push(...fileTasks);

            // Add to search index
            if (searchEngine) {
              const tags = extractTags(content);
              searchEngine.add({
                id: filename,
                title: filename.replace('.md', ''),
                filename: filename,
                content: content,
                tags: tags.join(' ')
              });
            }
          } catch (err) {
            // ignore file read errors for robustness
            console.error('Indexer error for', file.filename, err);
          }
        })
      );

      // Generate virtual temporal nodes for daily notes
      const virtualNodes = generateVirtualTemporalNodes(fileContents.map((f) => f.filename));
      Object.assign(graph, virtualNodes);

      try {
        console.log('[IndexerWorker] completed graph. nodes:', Object.keys(graph).length);
      } catch {
        // ignore log errors
      }

      try {
        parentPort?.postMessage({ type: 'graph-complete', data: { graph, tasks } });
      } catch (err) {
        try {
          console.error('[IndexerWorker] failed to post graph-complete', err);
          parentPort?.postMessage({ type: 'graph-error', error: String(err) });
        } catch {
          // swallow secondary failures
        }
      }
    } catch (err) {
      console.error('Indexer failed:', err);
      parentPort?.postMessage({ type: 'graph-error', error: String(err) });
    }
  }
);

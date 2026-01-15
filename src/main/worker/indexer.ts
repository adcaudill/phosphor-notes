import { parentPort } from 'worker_threads';

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
 * Extract wikilinks from markdown content
 * Converts [[filename]] or [[filename.md]] format
 * Always returns filenames with .md extension
 */
function extractWikilinks(content: string): string[] {
  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const links: string[] = [];

  let match;
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    let link = match[1].trim();
    if (!link) continue; // Skip empty matches

    // Normalize: ensure .md extension
    if (!link.endsWith('.md')) {
      link += '.md';
    }

    links.push(link);
  }

  return links;
}

/**
 * Get implicit parent links for a nested filepath
 * e.g., "People/John.md" returns ["People.md"]
 * For deeply nested paths, returns parents from shallowest to deepest
 */
function getImplicitPathLinks(filename: string): string[] {
  const implicitLinks: string[] = [];

  if (filename.includes('/')) {
    const parts = filename.split('/');
    // Create links to each parent level, from shallowest to deepest
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join('/') + '.md';
      implicitLinks.push(parentPath);
    }
  }

  return implicitLinks;
}

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

    // Try emoji style: 📅 YYYY-MM-DD
    const emojiDateMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    if (emojiDateMatch) {
      dueDate = emojiDateMatch[1];
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

parentPort?.on(
  'message',
  async (
    msg: string | { type: string; query: string } | { vaultPath?: string; masterKey?: string }
  ) => {
    // Handle search queries
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg as { type?: unknown }).type === 'search'
    ) {
      const searchMsg = msg as { type: 'search'; query: string };
      if (!searchEngine) {
        // Return empty results if search engine not ready yet
        parentPort?.postMessage({
          type: 'search-results',
          data: []
        });
        return;
      }
      const results = searchEngine.search(searchMsg.query, { prefix: true });

      // Generate snippets from content
      const resultsWithSnippets = results.slice(0, 20).map((result: Record<string, unknown>) => {
        const content = typeof result.content === 'string' ? result.content : '';
        // Find the first line containing the search query (case-insensitive)
        const lines = content.split('\n').filter((line) => line.trim().length > 0);
        let snippet = '';

        for (const line of lines) {
          if (line.toLowerCase().includes(searchMsg.query.toLowerCase())) {
            // Extract first 100 chars and clean up
            snippet = line.substring(0, 120).trim();
            if (snippet.length === 120) snippet += '…';
            break;
          }
        }

        // If no match found in content but title matched, use first non-empty line
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
        data: resultsWithSnippets
      });
      return;
    }

    // Handle initial indexing - msg is an array of { filename, content } objects
    if (!Array.isArray(msg)) {
      return;
    }

    const fileContents = msg as Array<{ filename: string; content: string }>;
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

            graph[filename] = allLinks;

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

      parentPort?.postMessage({ type: 'graph-complete', data: { graph, tasks } });
    } catch (err) {
      console.error('Indexer failed:', err);
      parentPort?.postMessage({ type: 'graph-error', error: String(err) });
    }
  }
);

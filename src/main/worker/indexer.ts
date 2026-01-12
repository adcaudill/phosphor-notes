import { parentPort } from 'worker_threads';
import * as fs from 'fs/promises';
import * as path from 'path';

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
    storeFields: ['title', 'filename', 'tags'],
    searchOptions: {
      boost: { title: 2, tags: 1.5 },
      fuzzy: 0.2
    }
  });
};

parentPort?.on('message', async (msg: string | { type: string; query: string }) => {
  // Handle search queries
  if (typeof msg === 'object' && msg.type === 'search') {
    if (!searchEngine) {
      // Return empty results if search engine not ready yet
      parentPort?.postMessage({
        type: 'search-results',
        data: []
      });
      return;
    }
    const results = searchEngine.search(msg.query, { prefix: true });
    parentPort?.postMessage({
      type: 'search-results',
      data: results.slice(0, 20)
    });
    return;
  }

  // Handle initial indexing (vaultPath is a string)
  const vaultPath = typeof msg === 'string' ? msg : null;
  if (!vaultPath) return;

  const graph: Graph = {};
  const tasks: Task[] = [];
  initSearch();

  try {
    const files = await getFilesRecursively(vaultPath);

    await Promise.all(
      files.map(async (filePath) => {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const filename = path.basename(filePath);

          // Extract wikilinks
          const links = extractWikilinks(content);
          graph[filename] = links;

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
          console.error('Indexer read error for', filePath, err);
        }
      })
    );

    parentPort?.postMessage({ type: 'graph-complete', data: { graph, tasks } });
  } catch (err) {
    console.error('Indexer failed:', err);
    parentPort?.postMessage({ type: 'graph-error', error: String(err) });
  }
});

async function getFilesRecursively(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? getFilesRecursively(res) : res;
    })
  );

  return Array.prototype.concat(...files).filter((f) => f.endsWith('.md'));
}

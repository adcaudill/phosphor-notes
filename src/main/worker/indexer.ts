import { parentPort } from 'worker_threads';
import * as fs from 'fs/promises';
import * as path from 'path';

// MiniSearch can have import issues in worker context
// Load it dynamically to handle both ESM and CommonJS contexts
let MiniSearch: any;
try {
  const imported = require('minisearch');
  MiniSearch = imported.default || imported;
} catch {
  // Fallback if require fails
  MiniSearch = require('minisearch');
}

type Graph = Record<string, string[]>;

export interface Task {
  file: string;
  line: number;
  status: 'todo' | 'doing' | 'done';
  text: string;
}

let searchEngine: any = null;

// Parse YAML frontmatter and extract tags
function extractTags(content: string): string[] {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return [];

  const frontmatter = frontmatterMatch[1];
  const tags: string[] = [];

  // Match tags in multiple formats:
  // 1. tags: [tag1, tag2] or tags: [tag1, tag2, tag3]
  const arrayMatch = frontmatter.match(/tags:\s*\[(.*?)\]/);
  if (arrayMatch) {
    const tagList = arrayMatch[1].split(',').map((t) => t.trim());
    tags.push(...tagList);
  }

  // 2. tags: tag1, tag2, tag3 (comma-separated)
  const csvMatch = frontmatter.match(/tags:\s*([^\n]+)/);
  if (csvMatch && !arrayMatch) {
    const tagList = csvMatch[1].split(',').map((t) => t.trim());
    tags.push(...tagList);
  }

  // 3. #tag1 #tag2 (hashtag format)
  const hashtagMatches = frontmatter.matchAll(/#(\w+)/g);
  for (const match of hashtagMatches) {
    if (!tags.includes(match[1])) {
      tags.push(match[1]);
    }
  }

  return tags;
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

    tasks.push({
      file: filename,
      line,
      status,
      text
    });
  }

  return tasks;
}

// Initialize MiniSearch
const initSearch = (): void => {
  searchEngine = new MiniSearch({
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

          const matches = content.matchAll(/\[\[(.*?)\]\]/g);
          const links: string[] = [];

          for (const match of matches) {
            let link = match[1];
            if (!link.endsWith('.md')) link += '.md';
            links.push(link);
          }

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

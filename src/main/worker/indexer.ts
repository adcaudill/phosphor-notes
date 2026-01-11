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

let searchEngine: any = null;

// Initialize MiniSearch
const initSearch = (): void => {
  searchEngine = new MiniSearch({
    fields: ['title', 'content'],
    storeFields: ['title', 'filename'],
    searchOptions: {
      boost: { title: 2 },
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

          // Add to search index
          if (searchEngine) {
            searchEngine.add({
              id: filename,
              title: filename.replace('.md', ''),
              filename: filename,
              content: content
            });
          }
        } catch (err) {
          // ignore file read errors for robustness
          console.error('Indexer read error for', filePath, err);
        }
      })
    );

    parentPort?.postMessage({ type: 'graph-complete', data: graph });
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

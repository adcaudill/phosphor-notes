import { parentPort } from 'worker_threads';
import * as fs from 'fs/promises';
import * as path from 'path';

type Graph = Record<string, string[]>;

parentPort?.on('message', async (vaultPath: string) => {
  const graph: Graph = {};

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

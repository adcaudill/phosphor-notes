import { Worker } from 'worker_threads';
import { join, resolve } from 'path';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { isDailyNote, extractDateHierarchy } from './graphBuilder';
import { getActiveMasterKey, isEncryptionEnabled } from './ipc';
import { decryptBuffer } from './crypto';

// Safe logging that ignores EPIPE errors during shutdown
const safeLog = (...args: unknown[]): void => {
  try {
    console.log(...args);
  } catch {
    // Ignore EPIPE errors that occur during shutdown
  }
};

const safeDebug = (msg: string): void => {
  try {
    console.debug(msg);
  } catch {
    // Ignore EPIPE errors that occur during shutdown
  }
};

const safeError = (msg: string, err?: unknown): void => {
  try {
    console.error(msg, err);
  } catch {
    // Ignore EPIPE errors that occur during shutdown
  }
};

interface WorkerMessage {
  type: string;
  data?: unknown;
  error?: unknown;
}

interface Task {
  file: string;
  line: number;
  status: 'todo' | 'doing' | 'done';
  text: string;
  dueDate?: string;
  completedAt?: string;
}

interface FileContent {
  filename: string;
  content: string;
}

let indexerWorker: Worker | null = null;
let lastGraph: Record<string, string[]> | null = null;
let lastTasks: Task[] | null = null;

// Helper: recursively find all .md files
async function getFilesRecursively(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.endsWith('.bak')) continue; // Ignore backup files
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getFilesRecursively(fullPath)));
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

// Helper: read a markdown file and decrypt if needed
async function readMarkdownFile(filePath: string, vaultPath: string): Promise<string> {
  const buffer = await fsp.readFile(filePath);

  // Check if vault is encrypted and we have a master key
  if (await isEncryptionEnabled(vaultPath)) {
    const masterKey = getActiveMasterKey();
    if (masterKey) {
      try {
        // Try to decrypt
        const decrypted = decryptBuffer(buffer, masterKey);
        return decrypted.toString('utf-8');
      } catch (err) {
        void err;
        // If decryption fails, assume it's plaintext (safety fallback)
        try {
          return buffer.toString('utf-8');
        } catch {
          return '';
        }
      }
    }
  }

  // Not encrypted or no master key - read as plaintext
  return buffer.toString('utf-8');
}

async function tryStartWorkerFromFile(
  workerPath: string,
  vaultPath: string,
  mainWindow: BrowserWindow
): Promise<void> {
  indexerWorker = new Worker(workerPath);

  // Notify renderer that indexing has started
  try {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('phosphor:status', {
        type: 'indexing-started',
        message: 'Indexing started'
      });
    }
  } catch (err) {
    console.warn('Failed to send status to renderer:', err);
  }

  indexerWorker.on('message', (msg: WorkerMessage) => {
    if (msg?.type === 'graph-complete') {
      const msgData = msg.data as { graph: Record<string, string[]>; tasks: Task[] };
      const graph = msgData.graph;
      const tasks = msgData.tasks || [];
      safeLog('Graph indexing complete. Nodes:', Object.keys(graph).length, 'Tasks:', tasks.length);
      lastGraph = graph as Record<string, string[]>;
      lastTasks = tasks;
      // Only send if window is still valid
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phosphor:graph-update', graph);
        mainWindow.webContents.send('phosphor:tasks-update', tasks);
      }
      try {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('phosphor:status', {
            type: 'indexing-complete',
            message: 'Indexing complete'
          });
        }
      } catch (err) {
        console.warn('Failed to send status to renderer:', err);
      }
      // Persist the graph atomically into the vault
      (async () => {
        try {
          if (!vaultPath) return;
          const cacheDir = join(vaultPath, '.phosphor');
          await fsp.mkdir(cacheDir, { recursive: true });
          const uniqueTmpPath = join(
            cacheDir,
            `graph.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
          );
          const outPath = join(cacheDir, 'graph.json');
          await fsp.writeFile(uniqueTmpPath, JSON.stringify(graph), 'utf-8');
          try {
            await fsp.rename(uniqueTmpPath, outPath);
          } catch (renameErr) {
            // If rename fails, try to clean up the tmp file
            try {
              await fsp.unlink(uniqueTmpPath);
            } catch {
              // Silently ignore cleanup errors
            }
            throw renameErr;
          }
          safeLog('Graph cache saved to', outPath);
        } catch (err) {
          safeError('Failed to persist graph cache:', err);
        }
      })();
    } else if (msg?.type === 'search-results') {
      try {
        console.debug('Received search results:', msg.data);
      } catch {
        // Silently ignore console errors
      }
      searchResultsCallback?.(msg.data as unknown[]);
    } else if (msg?.type === 'graph-error') {
      console.error('Indexer error:', msg.error);
    }
  });

  indexerWorker.on('error', (err) => {
    console.error('Indexer worker error:', err);
  });

  // Read all markdown files and decrypt if needed
  try {
    const mdFiles = await getFilesRecursively(vaultPath);
    const fileContents: FileContent[] = [];

    for (const filePath of mdFiles) {
      try {
        const content = await readMarkdownFile(filePath, vaultPath);
        const filename = filePath.substring(vaultPath.length + 1).replace(/\\/g, '/');
        fileContents.push({ filename, content });
      } catch (err) {
        console.warn(`Failed to read file ${filePath}:`, err);
      }
    }

    safeLog('Sending', fileContents.length, 'files to indexer worker');
    indexerWorker.postMessage(fileContents);
  } catch (err) {
    console.error('Failed to read vault files:', err);
  }
}

export async function startIndexing(vaultPath: string, mainWindow: BrowserWindow): Promise<void> {
  // Resolve worker path relative to compiled main directory
  const workerPath = join(__dirname, 'worker', 'indexer.js');

  try {
    if (indexerWorker) {
      indexerWorker.terminate();
      indexerWorker = null;
    }

    safeLog('Indexer: workerPath=', workerPath, 'exists?', fs.existsSync(workerPath));
    if (fs.existsSync(workerPath)) {
      // Normal: run compiled worker
      safeLog('Indexer: starting compiled worker');
      await tryStartWorkerFromFile(workerPath, vaultPath, mainWindow);
      return;
    }

    // Fallback for dev: transpile the TS source at runtime and run via eval
    const possibleSrc = resolve(process.cwd(), 'src', 'main', 'worker', 'indexer.ts');
    if (fs.existsSync(possibleSrc)) {
      try {
        safeLog('Indexer: compiled worker missing, using runtime TS fallback from', possibleSrc);
        const tsCode = fs.readFileSync(possibleSrc, 'utf-8');
        // Transpile with Typescript at runtime to CommonJS
        // Import lazily to avoid top-level dependency when not needed
        const ts = await import('typescript');
        const transpiled = ts.transpileModule(tsCode, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            jsx: ts.JsxEmit.React
          }
        }).outputText;

        // Start worker from transpiled code using eval
        indexerWorker = new Worker(transpiled, { eval: true });

        // Notify renderer that indexing has started
        try {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('phosphor:status', {
              type: 'indexing-started',
              message: 'Indexing started'
            });
          }
        } catch (err) {
          console.warn('Failed to send status to renderer:', err);
        }

        indexerWorker.on('message', (msg: WorkerMessage) => {
          if (msg?.type === 'graph-complete') {
            const msgData = msg.data as { graph: Record<string, string[]>; tasks: Task[] };
            const graph = msgData.graph;
            const tasks = msgData.tasks || [];
            safeLog(
              'Graph indexing complete. Nodes:',
              Object.keys(graph).length,
              'Tasks:',
              tasks.length
            );
            lastGraph = graph as Record<string, string[]>;
            lastTasks = tasks;
            // Only send if window is still valid
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send('phosphor:graph-update', graph);
              mainWindow.webContents.send('phosphor:tasks-update', tasks);
            }
            try {
              if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('phosphor:status', {
                  type: 'indexing-complete',
                  message: 'Indexing complete'
                });
              }
            } catch (err) {
              console.warn('Failed to send status to renderer:', err);
            }
            // Persist the graph atomically into the vault
            (async () => {
              try {
                if (!vaultPath) return;
                const cacheDir = join(vaultPath, '.phosphor');
                await fsp.mkdir(cacheDir, { recursive: true });
                const uniqueTmpPath = join(
                  cacheDir,
                  `graph.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
                );
                const outPath = join(cacheDir, 'graph.json');
                await fsp.writeFile(uniqueTmpPath, JSON.stringify(graph), 'utf-8');
                try {
                  await fsp.rename(uniqueTmpPath, outPath);
                } catch (renameErr) {
                  // If rename fails, try to clean up the tmp file
                  try {
                    await fsp.unlink(uniqueTmpPath);
                  } catch {
                    // Silently ignore cleanup errors
                  }
                  throw renameErr;
                }
                console.log('Graph cache saved to', outPath);
              } catch (err) {
                console.error('Failed to persist graph cache:', err);
              }
            })();
          } else if (msg?.type === 'search-results') {
            searchResultsCallback?.(msg.data as unknown[]);
          } else if (msg?.type === 'graph-error') {
            safeError('Indexer error:', msg.error);
          }
        });

        indexerWorker.on('error', (err) => safeError('Indexer worker error:', err));

        // Read all markdown files and decrypt if needed
        try {
          const mdFiles = await getFilesRecursively(vaultPath);
          const fileContents: FileContent[] = [];

          for (const filePath of mdFiles) {
            try {
              const content = await readMarkdownFile(filePath, vaultPath);
              const filename = filePath.substring(vaultPath.length + 1).replace(/\\/g, '/');
              fileContents.push({ filename, content });
            } catch (err) {
              safeLog(`Failed to read file ${filePath}:`, err);
            }
          }

          safeLog('Sending', fileContents.length, 'files to indexer worker');
          indexerWorker.postMessage(fileContents);
        } catch (err) {
          safeError('Failed to read vault files:', err);
        }
        safeLog('Indexer: runtime-transpiled worker started');
        return;
      } catch (err) {
        safeError('Runtime transpile failed:', err);
      }
    }

    // If we reach here, no worker could be started
    safeError(`Indexer worker not found at ${workerPath} and no source fallback available.`);
  } catch (err) {
    safeError('Failed to start indexer worker:', err);
  }
}

export function stopIndexing(): void {
  if (indexerWorker) {
    try {
      indexerWorker.terminate();
    } catch (err) {
      console.error('Error terminating indexer worker:', err);
    }
    indexerWorker = null;
  }
}

export function getLastGraph(): Record<string, string[]> | null {
  return lastGraph;
}

export function getLastTasks(): Task[] | null {
  return lastTasks;
}

let searchResultsCallback: ((results: unknown[]) => void) | null = null;

export function performSearch(query: string, callback: (results: unknown[]) => void): void {
  if (!indexerWorker) {
    console.warn('Search called but no indexer worker available');
    callback([]);
    return;
  }
  try {
    console.debug('Performing search for:', query);
  } catch {
    // Silently ignore console errors
  }
  searchResultsCallback = callback;
  indexerWorker.postMessage({ type: 'search', query });
}

export function setSearchResultsHandler(handler: (results: unknown[]) => void): void {
  searchResultsCallback = handler;
}

export function registerSearchResponseHandler(): void {
  if (!indexerWorker) return;
  indexerWorker.on('message', (msg: WorkerMessage) => {
    if (msg?.type === 'search-results') {
      searchResultsCallback?.(msg.data as unknown[]);
    }
  });
}
/**
 * Update tasks for a single changed file (efficient incremental update)
 */
export async function updateTasksForFile(
  vaultPath: string,
  filename: string,
  mainWindow: BrowserWindow
): Promise<void> {
  try {
    // Only operate on markdown files
    if (!filename.endsWith('.md')) {
      safeDebug(`Skipping task update for non-markdown file: ${filename}`);
      return;
    }
    const filePath = join(vaultPath, filename);
    // Use shared reader so encrypted vaults are handled the same way as the worker
    const content = await readMarkdownFile(filePath, vaultPath);

    // Extract tasks from this file using the same regex as the worker
    const taskRegex = /^\s*-\s*\[([ x/])\]\s*(.*?)$/gm;
    const fileTasks: Task[] = [];

    let match;
    while ((match = taskRegex.exec(content)) !== null) {
      const status = match[1] === ' ' ? 'todo' : match[1] === '/' ? 'doing' : 'done';
      const text = match[2].trim();
      const line = content.substring(0, match.index).split('\n').length;

      fileTasks.push({
        file: filename,
        line,
        status,
        text
      });
    }

    // Update the task index: remove old tasks for this file, add new ones
    if (lastTasks) {
      lastTasks = lastTasks.filter((task) => task.file !== filename);
      lastTasks.push(...fileTasks);
    } else {
      lastTasks = fileTasks;
    }

    // Send updated tasks to renderer
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('phosphor:tasks-update', lastTasks);
    }
    try {
      safeDebug(`Updated tasks for ${filename}: ${fileTasks.length} tasks`);
    } catch {
      // Silently ignore errors
    }
  } catch (err) {
    safeError(`Failed to update tasks for file: ${filename}`, err);
  }
}

/**
 * Extract wikilinks from markdown content (same logic as worker)
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
 * Ensure temporal virtual nodes (month/year) exist and reference the daily note.
 * Mutates `lastGraph` in-place.
 */
function attachDailyToTemporalNodes(filename: string): void {
  try {
    if (!lastGraph) return;
    if (!isDailyNote(filename)) return;
    const hierarchy = extractDateHierarchy(filename);
    if (!hierarchy) return;

    // Ensure month node links to this daily note
    if (!lastGraph[hierarchy.month]) lastGraph[hierarchy.month] = [];
    if (!lastGraph[hierarchy.month].includes(filename)) {
      lastGraph[hierarchy.month].push(filename);
      lastGraph[hierarchy.month].sort();
    }

    // Ensure year node links to the month node
    if (!lastGraph[hierarchy.year]) lastGraph[hierarchy.year] = [];
    if (!lastGraph[hierarchy.year].includes(hierarchy.month)) {
      lastGraph[hierarchy.year].push(hierarchy.month);
      lastGraph[hierarchy.year].sort();
    }
  } catch {
    // Swallow errors to avoid breaking watcher flow
  }
}

/**
 * Update graph for a changed file (efficient incremental update)
 * This is called when an existing file is modified to update its outgoing links
 * and handle any new wikilinks that were added
 */
export async function updateGraphForChangedFile(
  vaultPath: string,
  filename: string,
  mainWindow: BrowserWindow
): Promise<void> {
  return updateGraphForSingleFile(vaultPath, filename, mainWindow, 'changed');
}

/**
 * Update graph for a single new file (efficient incremental update)
 * This is called when a new file is created to avoid full re-indexing
 */
export async function updateGraphForFile(
  vaultPath: string,
  filename: string,
  mainWindow: BrowserWindow
): Promise<void> {
  return updateGraphForSingleFile(vaultPath, filename, mainWindow, 'added');
}

/**
 * Shared implementation for updating the graph for a single file.
 * `action` is used only for debug messages ('changed' | 'added').
 */
async function updateGraphForSingleFile(
  vaultPath: string,
  filename: string,
  mainWindow: BrowserWindow,
  action: 'changed' | 'added'
): Promise<void> {
  try {
    // Only operate on markdown files
    if (!filename.endsWith('.md')) {
      safeDebug(`Skipping graph update for non-markdown file: ${filename}`);
      return;
    }

    // If we don't have a graph yet, skip (full indexing hasn't completed)
    if (!lastGraph) {
      safeDebug(`Skipping graph update for ${action} file ${filename}: graph not yet initialized`);
      return;
    }

    const filePath = join(vaultPath, filename);

    // Check if file exists before reading
    try {
      await fsp.access(filePath);
    } catch {
      safeDebug(`Skipping graph update for ${filename}: file does not exist`);
      return;
    }

    const content = await readMarkdownFile(filePath, vaultPath);

    // Extract wikilinks and implicit parent links from the file
    const wikilinks = extractWikilinks(content);
    const implicitLinks = getImplicitPathLinks(filename);
    const allOutgoingLinks = [...new Set([...wikilinks, ...implicitLinks])];

    // Update the graph with the file's current outgoing links
    lastGraph[filename] = allOutgoingLinks;

    // Ensure target nodes exist in the graph so the UI can display linked-to nodes.
    for (const target of allOutgoingLinks) {
      if (!lastGraph[target]) lastGraph[target] = [];
    }

    // Attach daily note to month/year virtual nodes
    attachDailyToTemporalNodes(filename);

    // Send updated graph to renderer
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('phosphor:graph-update', lastGraph);
    }

    try {
      safeDebug(
        `Updated graph for ${action} file ${filename}: ${allOutgoingLinks.length} outgoing links`
      );
    } catch {
      // Silently ignore errors
    }

    // Persist the updated graph atomically
    (async () => {
      try {
        const cacheDir = join(vaultPath, '.phosphor');
        await fsp.mkdir(cacheDir, { recursive: true });
        const uniqueTmpPath = join(
          cacheDir,
          `graph.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
        );
        const outPath = join(cacheDir, 'graph.json');
        await fsp.writeFile(uniqueTmpPath, JSON.stringify(lastGraph), 'utf-8');
        try {
          await fsp.rename(uniqueTmpPath, outPath);
        } catch (renameErr) {
          // If rename fails, try to clean up the tmp file
          try {
            await fsp.unlink(uniqueTmpPath);
          } catch {
            // Silently ignore cleanup errors
          }
          throw renameErr;
        }
        safeDebug(
          action === 'changed' ? 'Graph cache updated for changed file' : 'Graph cache updated'
        );
      } catch (err) {
        safeError('Failed to persist updated graph cache:', err);
      }
    })();
  } catch (err) {
    safeError(`Failed to update graph for ${action} file: ${filename}`, err);
  }
}

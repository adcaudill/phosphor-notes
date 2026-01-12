import { Worker } from 'worker_threads';
import { join, resolve } from 'path';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
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
          const tmpPath = join(cacheDir, 'graph.json.tmp');
          const outPath = join(cacheDir, 'graph.json');
          await fsp.writeFile(tmpPath, JSON.stringify(graph), 'utf-8');
          await fsp.rename(tmpPath, outPath);
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
                const tmpPath = join(cacheDir, 'graph.json.tmp');
                const outPath = join(cacheDir, 'graph.json');
                await fsp.writeFile(tmpPath, JSON.stringify(graph), 'utf-8');
                await fsp.rename(tmpPath, outPath);
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
    const filePath = join(vaultPath, filename);
    const content = await fsp.readFile(filePath, 'utf-8');

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

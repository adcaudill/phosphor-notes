import { Worker } from 'worker_threads';
import { join, resolve } from 'path';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

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
}

let indexerWorker: Worker | null = null;
let lastGraph: Record<string, string[]> | null = null;
let lastTasks: Task[] | null = null;

async function tryStartWorkerFromFile(
  workerPath: string,
  vaultPath: string,
  mainWindow: BrowserWindow
): Promise<void> {
  indexerWorker = new Worker(workerPath);

  // Notify renderer that indexing has started
  try {
    mainWindow.webContents.send('phosphor:status', {
      type: 'indexing-started',
      message: 'Indexing started'
    });
  } catch (err) {
    console.warn('Failed to send status to renderer:', err);
  }

  indexerWorker.on('message', (msg: WorkerMessage) => {
    if (msg?.type === 'graph-complete') {
      const msgData = msg.data as { graph: Record<string, string[]>; tasks: Task[] };
      const graph = msgData.graph;
      const tasks = msgData.tasks || [];
      console.log(
        'Graph indexing complete. Nodes:',
        Object.keys(graph).length,
        'Tasks:',
        tasks.length
      );
      lastGraph = graph as Record<string, string[]>;
      lastTasks = tasks;
      mainWindow.webContents.send('phosphor:graph-update', graph);
      mainWindow.webContents.send('phosphor:tasks-update', tasks);
      try {
        mainWindow.webContents.send('phosphor:status', {
          type: 'indexing-complete',
          message: 'Indexing complete'
        });
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
      console.debug('Received search results:', msg.data);
      searchResultsCallback?.(msg.data as unknown[]);
    } else if (msg?.type === 'graph-error') {
      console.error('Indexer error:', msg.error);
    }
  });

  indexerWorker.on('error', (err) => {
    console.error('Indexer worker error:', err);
  });

  indexerWorker.postMessage(vaultPath);
}

export async function startIndexing(vaultPath: string, mainWindow: BrowserWindow): Promise<void> {
  // Resolve worker path relative to compiled main directory
  const workerPath = join(__dirname, 'worker', 'indexer.js');

  try {
    if (indexerWorker) {
      indexerWorker.terminate();
      indexerWorker = null;
    }

    console.log('Indexer: workerPath=', workerPath, 'exists?', fs.existsSync(workerPath));
    if (fs.existsSync(workerPath)) {
      // Normal: run compiled worker
      console.log('Indexer: starting compiled worker');
      await tryStartWorkerFromFile(workerPath, vaultPath, mainWindow);
      return;
    }

    // Fallback for dev: transpile the TS source at runtime and run via eval
    const possibleSrc = resolve(process.cwd(), 'src', 'main', 'worker', 'indexer.ts');
    if (fs.existsSync(possibleSrc)) {
      try {
        console.log(
          'Indexer: compiled worker missing, using runtime TS fallback from',
          possibleSrc
        );
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
          mainWindow.webContents.send('phosphor:status', {
            type: 'indexing-started',
            message: 'Indexing started'
          });
        } catch (err) {
          console.warn('Failed to send status to renderer:', err);
        }

        indexerWorker.on('message', (msg: WorkerMessage) => {
          if (msg?.type === 'graph-complete') {
            const msgData = msg.data as { graph: Record<string, string[]>; tasks: Task[] };
            const graph = msgData.graph;
            const tasks = msgData.tasks || [];
            console.log(
              'Graph indexing complete. Nodes:',
              Object.keys(graph).length,
              'Tasks:',
              tasks.length
            );
            lastGraph = graph as Record<string, string[]>;
            lastTasks = tasks;
            mainWindow.webContents.send('phosphor:graph-update', graph);
            mainWindow.webContents.send('phosphor:tasks-update', tasks);
            try {
              mainWindow.webContents.send('phosphor:status', {
                type: 'indexing-complete',
                message: 'Indexing complete'
              });
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
            console.error('Indexer error:', msg.error);
          }
        });

        indexerWorker.on('error', (err) => console.error('Indexer worker error:', err));

        indexerWorker.postMessage(vaultPath);
        console.log('Indexer: runtime-transpiled worker started');
        return;
      } catch (err) {
        console.error('Runtime transpile failed:', err);
      }
    }

    // If we reach here, no worker could be started
    console.error('Indexer worker not found at', workerPath, 'and no source fallback available.');
  } catch (err) {
    console.error('Failed to start indexer worker:', err);
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
  console.debug('Performing search for:', query);
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
    mainWindow.webContents.send('phosphor:tasks-update', lastTasks);
    console.debug(`Updated tasks for ${filename}: ${fileTasks.length} tasks`);
  } catch (err) {
    console.error('Failed to update tasks for file:', filename, err);
  }
}

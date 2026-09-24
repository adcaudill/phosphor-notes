import { Worker } from 'worker_threads';
import { join, resolve } from 'path';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { isDailyNote, extractDateHierarchy } from './graphBuilder';
import { extractWikilinks, getImplicitPathLinks } from '../shared/wikilinks';
import { extractTasksFromContent, type Task } from '../shared/tasks';
import * as vaultReader from './vaultReader';
import {
  buildSnapshotFromCounts,
  tokenizeWithCaseMeta,
  type PredictionModelSnapshot,
  type TokenCaseStats,
  type TrainOptions
} from '../shared/predictionModel';

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
  requestId?: string;
}

interface FileContent {
  filename: string;
  content: string;
}

let indexerWorker: Worker | null = null;
let searchRequestCounter = 0;
const pendingSearches = new Map<
  string,
  { resolve: (results: unknown[]) => void; timer: NodeJS.Timeout }
>();

// Resolve a specific search request by id, as echoed back by the worker.
// Used by `searchAsync` to let concurrent callers (e.g. the GUI and an MCP
// tool searching at the same time) each get their own results instead of
// racing on a single module-level callback (see `searchResultsCallback`
// below, which the legacy `performSearch` API still uses internally).
function resolvePendingSearch(requestId: string, results: unknown[]): void {
  const pending = pendingSearches.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSearches.delete(requestId);
  pending.resolve(results);
}
let lastGraph: Record<string, string[]> | null = null;
let lastTasks: Task[] | null = null;
let lastPredictionModel: PredictionModelSnapshot | null = null;
let lastPredictionModelSerialized: string | null = null;

interface FilePredictionStats {
  tokenCount: number;
  wordCounts: Map<string, number>;
  bigramCounts: Map<string, Map<string, number>>;
  trigramCounts: Map<string, Map<string, number>>;
  caseStats: Map<string, TokenCaseStats>;
}

const predictionOptions: TrainOptions = {
  maxTopPerPrefix: 10,
  maxBigramPerWord: 10,
  minBigramCount: 2,
  maxTrigramPerKey: 15,
  minTrigramCount: 2,
  minWordLength: 2
};

const perFilePredictionStats = new Map<string, FilePredictionStats>();
const globalWordCounts = new Map<string, number>();
const globalBigramCounts = new Map<string, Map<string, number>>();
const globalTrigramCounts = new Map<string, Map<string, number>>();
const globalCaseStats = new Map<string, TokenCaseStats>();
let globalTokenCount = 0;

const predictionUpdateTimers = new Map<string, NodeJS.Timeout>();
const PREDICTION_UPDATE_DEBOUNCE_MS = 60_000;

function addCounts(target: Map<string, number>, delta: Map<string, number>, sign: 1 | -1): void {
  for (const [word, count] of delta.entries()) {
    const next = (target.get(word) ?? 0) + sign * count;
    if (next <= 0) {
      target.delete(word);
    } else {
      target.set(word, next);
    }
  }
}

function addBigramCounts(
  target: Map<string, Map<string, number>>,
  delta: Map<string, Map<string, number>>,
  sign: 1 | -1
): void {
  for (const [word, nextMap] of delta.entries()) {
    let acc = target.get(word);
    if (!acc) {
      if (sign < 0) continue;
      acc = new Map<string, number>();
      target.set(word, acc);
    }
    for (const [next, count] of nextMap.entries()) {
      const updated = (acc.get(next) ?? 0) + sign * count;
      if (updated <= 0) {
        acc.delete(next);
      } else {
        acc.set(next, updated);
      }
    }
    if (acc.size === 0) {
      target.delete(word);
    }
  }
}

const addTrigramCounts = addBigramCounts;

function addCaseStats(
  target: Map<string, TokenCaseStats>,
  delta: Map<string, TokenCaseStats>,
  sign: 1 | -1
): void {
  for (const [word, stats] of delta.entries()) {
    const existing = target.get(word) ?? {
      lower: 0,
      capitalizedStart: 0,
      capitalizedMid: 0,
      upper: 0
    };
    const next: TokenCaseStats = {
      lower: existing.lower + sign * stats.lower,
      capitalizedStart: existing.capitalizedStart + sign * stats.capitalizedStart,
      capitalizedMid: existing.capitalizedMid + sign * stats.capitalizedMid,
      upper: existing.upper + sign * stats.upper
    };

    const total = next.lower + next.capitalizedStart + next.capitalizedMid + next.upper;
    if (total <= 0) {
      target.delete(word);
    } else {
      target.set(word, next);
    }
  }
}

function computePredictionStats(text: string): FilePredictionStats {
  const tokens = tokenizeWithCaseMeta(text, { minWordLength: predictionOptions.minWordLength });
  const wordCounts = new Map<string, number>();
  const bigramCounts = new Map<string, Map<string, number>>();
  const trigramCounts = new Map<string, Map<string, number>>();
  const caseStats = new Map<string, TokenCaseStats>();

  for (let i = 0; i < tokens.length; i++) {
    const { word, casing, isSentenceStart } = tokens[i];
    const nextWord = tokens[i + 1]?.word;
    const prevWord = tokens[i - 1]?.word;

    wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    if (nextWord) {
      let nextMap = bigramCounts.get(word);
      if (!nextMap) {
        nextMap = new Map<string, number>();
        bigramCounts.set(word, nextMap);
      }
      nextMap.set(nextWord, (nextMap.get(nextWord) ?? 0) + 1);
    }

    if (prevWord && word && nextWord) {
      const key = `${prevWord} ${word}`;
      let nextMap = trigramCounts.get(key);
      if (!nextMap) {
        nextMap = new Map<string, number>();
        trigramCounts.set(key, nextMap);
      }
      nextMap.set(nextWord, (nextMap.get(nextWord) ?? 0) + 1);
    }

    const existing = caseStats.get(word) ?? {
      lower: 0,
      capitalizedStart: 0,
      capitalizedMid: 0,
      upper: 0
    };
    if (casing === 'upper') {
      existing.upper += 1;
    } else if (casing === 'capitalized') {
      if (isSentenceStart) {
        existing.capitalizedStart += 1;
      } else {
        existing.capitalizedMid += 1;
      }
    } else {
      existing.lower += 1;
    }
    caseStats.set(word, existing);
  }

  return {
    tokenCount: tokens.length,
    wordCounts,
    bigramCounts,
    trigramCounts,
    caseStats
  };
}

function rebuildPredictionSnapshot(mainWindow: BrowserWindow): void {
  try {
    const model = buildSnapshotFromCounts(
      globalWordCounts,
      globalBigramCounts,
      globalTrigramCounts,
      globalTokenCount,
      globalCaseStats,
      predictionOptions
    );

    lastPredictionModelSerialized = JSON.stringify(model);
    lastPredictionModel = model;

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('phosphor:prediction-model', lastPredictionModelSerialized);
    }

    try {
      safeLog(
        '[Indexer] rebuilt prediction model. tokens:',
        model.tokenCount,
        'unique:',
        model.uniqueTokens,
        'bytes:',
        lastPredictionModelSerialized.length
      );
    } catch {
      // ignore logging errors
    }
  } catch (err) {
    safeError('Failed to rebuild prediction model:', err);
    lastPredictionModel = null;
    lastPredictionModelSerialized = null;
  }
}

function applyFileStats(filename: string, stats: FilePredictionStats | null): void {
  const existing = perFilePredictionStats.get(filename);
  if (existing) {
    globalTokenCount = Math.max(0, globalTokenCount - existing.tokenCount);
    addCounts(globalWordCounts, existing.wordCounts, -1);
    addBigramCounts(globalBigramCounts, existing.bigramCounts, -1);
    addTrigramCounts(globalTrigramCounts, existing.trigramCounts, -1);
    addCaseStats(globalCaseStats, existing.caseStats, -1);
  }

  if (stats) {
    globalTokenCount += stats.tokenCount;
    addCounts(globalWordCounts, stats.wordCounts, 1);
    addBigramCounts(globalBigramCounts, stats.bigramCounts, 1);
    addTrigramCounts(globalTrigramCounts, stats.trigramCounts, 1);
    addCaseStats(globalCaseStats, stats.caseStats, 1);
    perFilePredictionStats.set(filename, stats);
  } else {
    perFilePredictionStats.delete(filename);
  }
}

async function updatePredictionModelForFile(
  vaultPath: string,
  filename: string,
  mainWindow: BrowserWindow
): Promise<void> {
  try {
    const filePath = join(vaultPath, filename);
    const content = await readMarkdownFile(filePath, vaultPath);
    const stats = computePredictionStats(content);
    applyFileStats(filename, stats);
    rebuildPredictionSnapshot(mainWindow);
  } catch (err) {
    const asNodeErr = err as NodeJS.ErrnoException;
    if (asNodeErr?.code === 'ENOENT') {
      applyFileStats(filename, null);
      rebuildPredictionSnapshot(mainWindow);
      return;
    }
    safeError(`Failed to update prediction model for file ${filename}:`, err);
  }
}

export function schedulePredictionModelUpdate(
  vaultPath: string,
  filename: string,
  mainWindow: BrowserWindow
): void {
  if (!filename.endsWith('.md')) return;
  const existing = predictionUpdateTimers.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    predictionUpdateTimers.delete(filename);
    void updatePredictionModelForFile(vaultPath, filename, mainWindow);
  }, PREDICTION_UPDATE_DEBOUNCE_MS);
  predictionUpdateTimers.set(filename, timer);
}

function seedPredictionModel(fileContents: FileContent[], mainWindow: BrowserWindow): void {
  perFilePredictionStats.clear();
  globalWordCounts.clear();
  globalBigramCounts.clear();
  globalTrigramCounts.clear();
  globalTokenCount = 0;

  for (const timer of predictionUpdateTimers.values()) {
    clearTimeout(timer);
  }
  predictionUpdateTimers.clear();

  for (const file of fileContents) {
    const stats = computePredictionStats(file.content);
    applyFileStats(file.filename, stats);
  }

  rebuildPredictionSnapshot(mainWindow);
}

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

// Helper: read a markdown file and decrypt if needed. Delegates to the
// shared vaultReader, which checks the file's own encryption header rather
// than the vault-wide "encryption enabled" flag this used to check, and
// throws instead of ever returning ciphertext as if it were plaintext. If
// the vault is locked or the file fails to decrypt, this returns an empty
// string rather than indexing garbage bytes as note content.
async function readMarkdownFile(filePath: string, _vaultPath: string): Promise<string> {
  try {
    const buffer = await vaultReader.readDecrypted(filePath);
    return buffer.toString('utf-8');
  } catch (err) {
    if (err instanceof vaultReader.VaultLockedError || err instanceof vaultReader.DecryptError) {
      return '';
    }
    throw err;
  }
}

export const TASKS_CACHE_VERSION = 1;

/**
 * Persists the task index to `<vault>/.phosphor/tasks.json`, atomically
 * (tmp-write-then-rename), mirroring the graph-cache pattern used
 * throughout this file. Derived/disposable by construction - a version
 * mismatch or read failure just means the cache is treated as absent and
 * repopulated by the next full reindex, never migrated in place. Swallows
 * its own errors (fire-and-forget), same as the existing graph-persist
 * blocks this is modeled on.
 */
function persistTasksCache(vaultPath: string, tasks: Task[]): void {
  (async () => {
    try {
      if (!vaultPath) return;
      const cacheDir = join(vaultPath, '.phosphor');
      await fsp.mkdir(cacheDir, { recursive: true });
      const uniqueTmpPath = join(
        cacheDir,
        `tasks.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
      );
      const outPath = join(cacheDir, 'tasks.json');
      const payload = JSON.stringify({ version: TASKS_CACHE_VERSION, tasks });
      await fsp.writeFile(uniqueTmpPath, payload, 'utf-8');
      try {
        await fsp.rename(uniqueTmpPath, outPath);
      } catch (renameErr) {
        try {
          await fsp.unlink(uniqueTmpPath);
        } catch {
          // Silently ignore cleanup errors
        }
        throw renameErr;
      }
      safeLog('Tasks cache saved to', outPath);
    } catch (err) {
      safeError('Failed to persist tasks cache:', err);
    }
  })();
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
    safeDebug(`Indexer message (compiled path) type=${msg?.type ?? 'unknown'}`);
    if (msg?.type === 'graph-complete') {
      const msgData = msg.data as {
        graph: Record<string, string[]>;
        tasks: Task[];
      };
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
      persistTasksCache(vaultPath, tasks);
    } else if (msg?.type === 'prediction-model') {
      const model = msg.data as PredictionModelSnapshot | null;
      lastPredictionModel = model;
      try {
        lastPredictionModelSerialized = model ? JSON.stringify(model) : null;
      } catch (err) {
        lastPredictionModelSerialized = null;
        safeError('Failed to serialize prediction model (compiled path):', err);
      }

      safeLog('Prediction model received (compiled path). tokens:', model?.tokenCount ?? 0);
      if (!mainWindow.isDestroyed() && lastPredictionModelSerialized) {
        mainWindow.webContents.send('phosphor:prediction-model', lastPredictionModelSerialized);
      }
    } else if (msg?.type === 'search-results') {
      try {
        console.debug('Received search results:', msg.data);
      } catch {
        // Silently ignore console errors
      }
      if (msg.requestId) {
        resolvePendingSearch(msg.requestId, msg.data as unknown[]);
      } else {
        searchResultsCallback?.(msg.data as unknown[]);
      }
    } else if (msg?.type === 'graph-error') {
      console.error('Indexer error:', msg.error);
    }
  });

  indexerWorker.on('error', (err) => {
    console.error('Indexer worker error:', err);
  });

  indexerWorker.on('exit', (code) => {
    safeLog('Indexer worker exited with code', code);
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
    seedPredictionModel(fileContents, mainWindow);
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

    lastPredictionModel = null;
    lastPredictionModelSerialized = null;
    perFilePredictionStats.clear();
    globalWordCounts.clear();
    globalBigramCounts.clear();
    globalTrigramCounts.clear();
    globalTokenCount = 0;
    for (const timer of predictionUpdateTimers.values()) {
      clearTimeout(timer);
    }
    predictionUpdateTimers.clear();

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
        let tsCode = fs.readFileSync(possibleSrc, 'utf-8');
        // Attempt to inline shared utils so the eval worker can resolve them
        // (worker_threads' `eval: true` mode can't resolve a normal module
        // import, so each shared module used by the worker is wrapped in an
        // IIFE and prepended instead). Any shared module the worker imports
        // needs this same treatment - it's easy to add a new import above
        // without remembering to extend this block, so check here first if
        // task/graph extraction silently breaks only in this dev fallback.
        try {
          const sharedModules = [
            { path: 'wikilinks.ts', symbols: ['extractWikilinks', 'getImplicitPathLinks'] },
            {
              path: 'tasks.ts',
              symbols: ['extractTasksFromContent'],
              // tasks.ts imports InvalidArgumentError from noteFormat.ts, which in
              // turn imports from renderer/src/utils/frontmatterUtils - not worth
              // inlining transitively for a dev-only fallback, and extractTasksFromContent
              // (the only symbol the worker actually calls) never touches that code path.
              stubImports: [{ from: './noteFormat', names: ['InvalidArgumentError'] }]
            }
          ];

          let prelude = '';
          for (const mod of sharedModules) {
            const sharedPath = resolve(process.cwd(), 'src', 'shared', mod.path);
            if (!fs.existsSync(sharedPath)) continue;
            let sharedCode = fs.readFileSync(sharedPath, 'utf-8');

            // Strip this module's own imports of other shared modules (they're
            // either inlined separately above/below, or stubbed - see stubImports).
            sharedCode = sharedCode.replace(/(^|\n)import\s+[^;]*from\s+['"]\.\/[^'"]+['"];?/g, '$1');
            // Remove top-level export keywords so declarations are available when wrapped
            sharedCode = sharedCode.replace(
              /(^|\n)export\s+(?=(async\s+function|function|const|let|var|class|interface|type|enum))/g,
              '$1'
            );

            const stubs = (mod.stubImports ?? [])
              .flatMap((s) => s.names)
              .map((name) => `class ${name} extends Error {}`)
              .join('\n');

            const returnedSymbols = mod.symbols
              .map((s) => `${s}: typeof ${s} !== 'undefined' ? ${s} : undefined`)
              .join(', ');
            const wrapped = `(function(){\n${stubs}\n${sharedCode}\nreturn { ${returnedSymbols} };\n})()`;

            // Remove the worker's own import line(s) for this shared module
            const importRe = new RegExp(
              `import\\s+[^;]*shared/${mod.path.replace('.ts', '')}[^;]*;?\\n?`,
              'g'
            );
            tsCode = tsCode.replace(importRe, '');

            const varName = `__phosphor_shared_${mod.path.replace(/\W/g, '_')}`;
            prelude += `const ${varName} = ${wrapped};\nconst { ${mod.symbols.join(', ')} } = ${varName};\n`;
          }

          tsCode = prelude + '\n' + tsCode;
        } catch (inlineErr) {
          safeError('Failed to inline shared util for runtime worker:', inlineErr);
        }

        // Transpile with esbuild at runtime to CommonJS
        // Import lazily to avoid top-level dependency when not needed
        const { transform } = await import('esbuild');
        const transpiled = (
          await transform(tsCode, {
            loader: 'ts',
            format: 'cjs',
            target: 'es2020'
          })
        ).code;

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
          safeDebug(`Indexer message (runtime path) type=${msg?.type ?? 'unknown'}`);
          if (msg?.type === 'graph-complete') {
            const msgData = msg.data as {
              graph: Record<string, string[]>;
              tasks: Task[];
            };

            const graph = msgData.graph;
            const tasks = msgData.tasks || [];

            // count edges for logging
            let edgeCount = 0;
            for (const targets of Object.values(graph)) {
              edgeCount += targets.length;
            }

            safeLog(
              'Graph indexing complete. Nodes:',
              Object.keys(graph).length,
              'Edges:',
              edgeCount,
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
            persistTasksCache(vaultPath, tasks);
          } else if (msg?.type === 'prediction-model') {
            const model = msg.data as PredictionModelSnapshot | null;

            lastPredictionModel = model;
            try {
              lastPredictionModelSerialized = model ? JSON.stringify(model) : null;
            } catch (err) {
              lastPredictionModelSerialized = null;

              safeError('Failed to serialize prediction model (runtime path):', err);
            }
            safeLog('Prediction model received (runtime path). tokens:', model?.tokenCount ?? 0);

            if (!mainWindow.isDestroyed() && lastPredictionModelSerialized) {
              mainWindow.webContents.send(
                'phosphor:prediction-model',
                lastPredictionModelSerialized
              );
            }
          } else if (msg?.type === 'search-results') {
            if (msg.requestId) {
              resolvePendingSearch(msg.requestId, msg.data as unknown[]);
            } else {
              searchResultsCallback?.(msg.data as unknown[]);
            }
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
          seedPredictionModel(fileContents, mainWindow);
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

    // If we reach here, no worker could be started and no source fallback was available.
    if (!fs.existsSync(possibleSrc)) {
      safeError(`Indexer worker not found at ${workerPath} and no source fallback available.`);
    }
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

/**
 * Reset all in-memory indexer state (used when switching vaults)
 */
export function resetIndexState(mainWindow?: BrowserWindow): void {
  lastGraph = null;
  lastTasks = null;
  lastPredictionModel = null;
  lastPredictionModelSerialized = null;

  perFilePredictionStats.clear();
  globalWordCounts.clear();
  globalBigramCounts.clear();
  globalTrigramCounts.clear();
  globalTokenCount = 0;

  for (const timer of predictionUpdateTimers.values()) {
    clearTimeout(timer);
  }
  predictionUpdateTimers.clear();

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Send empty graph/tasks/prediction to renderer so UI clears quickly
      mainWindow.webContents.send('phosphor:graph-update', {});
      mainWindow.webContents.send('phosphor:tasks-update', []);
      mainWindow.webContents.send('phosphor:prediction-model', null);
    }
  } catch (err) {
    safeError('Failed to notify renderer of reset index state:', err);
  }
}

export function getLastGraph(): Record<string, string[]> | null {
  return lastGraph;
}

export function getLastPredictionModel(): PredictionModelSnapshot | null {
  return lastPredictionModel;
}

export function getLastPredictionModelSerialized(): string | null {
  return lastPredictionModelSerialized;
}

export function getLastTasks(): Task[] | null {
  return lastTasks;
}

let searchResultsCallback: ((results: unknown[]) => void) | null = null;

/**
 * Correlated search: tags each request with a unique id that the worker
 * echoes back in its response, so concurrent callers (e.g. the GUI and an
 * MCP tool searching at the same time) each get their own results instead
 * of racing on a single shared callback. Prefer this over `performSearch`
 * below for any new caller.
 */
export function searchAsync(
  query: string,
  opts?: { timeoutMs?: number; combineWith?: 'OR' | 'AND' }
): Promise<unknown[]> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    if (!indexerWorker) {
      console.warn('Search called but no indexer worker available');
      resolve([]);
      return;
    }
    try {
      console.debug('Performing search for:', query);
    } catch {
      // Silently ignore console errors
    }
    const requestId = `search-${++searchRequestCounter}-${Date.now()}`;
    const timer = setTimeout(() => {
      pendingSearches.delete(requestId);
      console.warn('Search timeout for query:', query);
      resolve([]);
    }, timeoutMs);
    pendingSearches.set(requestId, { resolve, timer });
    indexerWorker.postMessage({ type: 'search', query, requestId, combineWith: opts?.combineWith });
  });
}

/** @deprecated Legacy callback-based search API, kept for compatibility. Prefer `searchAsync`. */
export function performSearch(query: string, callback: (results: unknown[]) => void): void {
  searchAsync(query).then(callback);
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

    // Same extraction function the full-vault worker scan uses, so this
    // incremental path can never again drop fields (dueDate/recurrence/
    // priority/completedAt) the full scan populates.
    const fileTasks = extractTasksFromContent(content, filename);

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
    persistTasksCache(vaultPath, lastTasks);
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

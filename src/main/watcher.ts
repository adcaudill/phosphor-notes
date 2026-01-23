import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import * as path from 'path';

// Safe logging that ignores EPIPE errors during shutdown
const safeLog = (...args: unknown[]): void => {
  try {
    console.log(...args);
  } catch {
    // Ignore EPIPE errors that occur during shutdown
  }
};

const safeDebug = (...args: unknown[]): void => {
  try {
    console.debug(...args);
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

let watcher: FSWatcher | null = null; // FSWatcher type
let lastSaveTime = 0; // Timestamp of last internal save
const debounceTimers: Map<string, NodeJS.Timeout> = new Map();
let onFileChangeCallback: ((filename: string) => void) | null = null; // Callback with filename
let onFileAddedCallback: ((filename: string) => void) | null = null; // Callback for newly added files
let onFileDeletedCallback: ((filename: string) => void) | null = null;

const DEBOUNCE_MS = 300; // Wait 300ms after last change event before sending to UI
const INTERNAL_SAVE_GRACE_MS = 500; // Ignore FS changes within 500ms of our own saves

/**
 * Start watching a vault directory for file changes.
 * Sends events to the renderer when files change, are deleted, or are added.
 */
export function setupWatcher(
  vaultPath: string,
  mainWindow: BrowserWindow,
  onFileChange?: (filename: string) => void,
  onFileAdded?: (filename: string) => void,
  onFileDeleted?: (filename: string) => void
): void {
  // Store the callbacks for re-indexing
  onFileChangeCallback = onFileChange || null;
  onFileAddedCallback = onFileAdded || null;
  onFileDeletedCallback = onFileDeleted || null;

  // Clean up any existing watcher
  if (watcher) {
    watcher.close();
    debounceTimers.clear();
  }

  watcher = chokidar.watch(vaultPath, {
    // Ignore dotfiles, system files, node_modules, _assets, and backups (.bak)
    ignored: /(^|[/\\])\.|\.DS_Store|node_modules|_assets|\.bak$/,
    persistent: true,
    ignoreInitial: true, // Don't fire "add" for every file on startup
    awaitWriteFinish: {
      stabilityThreshold: 200, // Wait 200ms of no changes before treating as final
      pollInterval: 100
    }
  });

  watcher.on('change', (filePath) => {
    const relativePath = path.relative(vaultPath, filePath);
    const isInternalSave = Date.now() - lastSaveTime < INTERNAL_SAVE_GRACE_MS;

    if (isInternalSave) {
      try {
        safeDebug('[Watcher] Internal save detected:', relativePath);
      } catch {
        // Silently ignore errors
      }
      // Still update tasks for internal saves, but skip the file-changed event
      if (onFileChangeCallback) {
        onFileChangeCallback(relativePath);
      }
      return;
    }

    // Debounce: wait for file system to stabilize
    debounce(relativePath, () => {
      try {
        safeDebug('[Watcher] File changed:', relativePath);
      } catch {
        // Silently ignore errors
      }
      // Only send if window is still valid
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vault:file-changed', relativePath);
      }
      // Trigger targeted re-indexing for this specific file
      if (onFileChangeCallback && relativePath.endsWith('.md')) {
        onFileChangeCallback(relativePath);
      }
    });
  });

  watcher.on('unlink', (filePath) => {
    const relativePath = path.relative(vaultPath, filePath);
    try {
      safeDebug('[Watcher] File deleted:', relativePath);
    } catch {
      // Silently ignore errors
    }
    // Only send if window is still valid
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vault:file-deleted', relativePath);
    }
    if (onFileDeletedCallback && relativePath.endsWith('.md')) {
      onFileDeletedCallback(relativePath);
    }
  });

  watcher.on('add', (filePath) => {
    const relativePath = path.relative(vaultPath, filePath);
    try {
      safeDebug('[Watcher] File added:', relativePath);
    } catch {
      // Silently ignore errors
    }
    // Only send if window is still valid
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vault:file-added', relativePath);
    }
    // Trigger graph update for the newly added file
    if (onFileAddedCallback && relativePath.endsWith('.md')) {
      onFileAddedCallback(relativePath);
    }
  });

  watcher.on('error', (error) => {
    safeError('[Watcher] Error:', error);
  });

  safeLog('[Watcher] Started watching:', vaultPath);
}

/**
 * Stop watching the vault directory.
 */
export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    debounceTimers.clear();
    safeLog('[Watcher] Stopped');
  }
}

/**
 * Mark that we just saved a file internally.
 * This prevents our own saves from being reported as external changes.
 */
export function markInternalSave(): void {
  lastSaveTime = Date.now();
}

/**
 * Debounce helper: delay sending change notifications to UI.
 * This prevents flickering when multiple FS events fire for a single save.
 */
function debounce(filePath: string, callback: () => void): void {
  // Clear existing timer for this file
  if (debounceTimers.has(filePath)) {
    clearTimeout(debounceTimers.get(filePath)!);
  }

  // Set new timer
  const timer = setTimeout(() => {
    callback();
    debounceTimers.delete(filePath);
  }, DEBOUNCE_MS);

  debounceTimers.set(filePath, timer);
}

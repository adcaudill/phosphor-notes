import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import * as path from 'path';

let watcher: FSWatcher | null = null; // FSWatcher type
let lastSaveTime = 0; // Timestamp of last internal save
const debounceTimers: Map<string, NodeJS.Timeout> = new Map();
let onFileChangeCallback: ((filename: string) => void) | null = null; // Callback with filename

const DEBOUNCE_MS = 300; // Wait 300ms after last change event before sending to UI
const INTERNAL_SAVE_GRACE_MS = 500; // Ignore FS changes within 500ms of our own saves

/**
 * Start watching a vault directory for file changes.
 * Sends events to the renderer when files change, are deleted, or are added.
 */
export function setupWatcher(
  vaultPath: string,
  mainWindow: BrowserWindow,
  onFileChange?: (filename: string) => void
): void {
  // Store the callback for re-indexing
  onFileChangeCallback = onFileChange || null;

  // Clean up any existing watcher
  if (watcher) {
    watcher.close();
    debounceTimers.clear();
  }

  watcher = chokidar.watch(vaultPath, {
    // Ignore dotfiles, system files, node_modules, and _assets (images)
    ignored: /(^|[/\\])\.|\.DS_Store|node_modules|_assets/,
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
      console.debug('[Watcher] Internal save detected:', relativePath);
      // Still update tasks for internal saves, but skip the file-changed event
      if (onFileChangeCallback) {
        onFileChangeCallback(relativePath);
      }
      return;
    }

    // Debounce: wait for file system to stabilize
    debounce(relativePath, () => {
      console.debug('[Watcher] File changed:', relativePath);
      mainWindow.webContents.send('vault:file-changed', relativePath);
      // Trigger targeted re-indexing for this specific file
      if (onFileChangeCallback) {
        onFileChangeCallback(relativePath);
      }
    });
  });

  watcher.on('unlink', (filePath) => {
    const relativePath = path.relative(vaultPath, filePath);
    console.debug('[Watcher] File deleted:', relativePath);
    mainWindow.webContents.send('vault:file-deleted', relativePath);
  });

  watcher.on('add', (filePath) => {
    const relativePath = path.relative(vaultPath, filePath);
    console.debug('[Watcher] File added:', relativePath);
    mainWindow.webContents.send('vault:file-added', relativePath);
  });

  watcher.on('error', (error) => {
    console.error('[Watcher] Error:', error);
  });

  console.log('[Watcher] Started watching:', vaultPath);
}

/**
 * Stop watching the vault directory.
 */
export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    debounceTimers.clear();
    console.log('[Watcher] Stopped');
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

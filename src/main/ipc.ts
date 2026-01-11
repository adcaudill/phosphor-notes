import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import * as fsp from 'fs/promises';
import * as fs from 'fs/promises';
import * as path from 'path';
import { startIndexing, stopIndexing, getLastGraph, performSearch } from './indexer';

// Store the active vault path in memory for this session
let activeVaultPath: string | null = null;

const CONFIG_DIR = path.join(app.getPath('userData'), '.phosphor');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

async function ensureConfigDir(): Promise<void> {
  try {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create config dir', err);
  }
}

async function saveLastVault(vaultPath: string): Promise<void> {
  try {
    await ensureConfigDir();
    const cfg = { lastVault: vaultPath };
    await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg), 'utf-8');
  } catch (err) {
    console.error('Failed to write config', err);
  }
}

async function loadLastVault(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const cfg = JSON.parse(raw);
    return cfg.lastVault || null;
  } catch {
    return null;
  }
}

export function setupIPC(mainWindow: BrowserWindow): void {
  // 1. Select Vault
  ipcMain.handle('vault:select', async () => {
    // Delegate to the dialog-based opener
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Phosphor Vault',
      buttonLabel: 'Open Vault'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const chosen = result.filePaths[0];
    await openVaultPath(chosen, mainWindow);
    return path.basename(chosen);
  });

  // Return current vault folder name (if already opened)
  ipcMain.handle('vault:current', async () => {
    if (!activeVaultPath) return null;
    return path.basename(activeVaultPath);
  });

  // Return cached graph if present (read from vault .phosphor/graph.json)
  ipcMain.handle('graph:load-cache', async () => {
    if (!activeVaultPath) return null;
    try {
      const cachePath = path.join(activeVaultPath, '.phosphor', 'graph.json');
      const raw = await fsp.readFile(cachePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  // Return last in-memory graph if available (sent recently by indexer)
  ipcMain.handle('graph:get', async () => {
    return getLastGraph();
  });

  // Search handler
  ipcMain.handle('vault:search', async (_, query: string) => {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('Search timeout for query:', query);
        resolve([]);
      }, 5000);

      performSearch(query, (results) => {
        clearTimeout(timeout);
        resolve(results);
      });
    });
  });

  // 2. Read Note
  ipcMain.handle('note:read', async (_, filename: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    // Security: Sanitize filename to prevent directory traversal (e.g. "../../../secret.txt")
    const safeName = path.basename(filename);
    const filePath = path.join(activeVaultPath, safeName);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (err: unknown) {
      // If file doesn't exist, return empty string or create it
      const e = err as { code?: string };
      if (e.code === 'ENOENT') {
        await fs.writeFile(filePath, ''); // Create empty file
        return '';
      }
      throw err;
    }
  });

  // 3. Save Note
  ipcMain.handle('note:save', async (_, filename: string, content: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    const safeName = path.basename(filename);
    const filePath = path.join(activeVaultPath, safeName);

    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return true;
    } catch (err) {
      console.error('Failed to save:', err);
      return false;
    }
  });

  // Save Asset (image/media) - returns filename
  ipcMain.handle('asset:save', async (_, buffer: ArrayBuffer, originalName: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    try {
      // Ensure _assets folder exists
      const assetsPath = path.join(activeVaultPath, '_assets');
      await fsp.mkdir(assetsPath, { recursive: true });

      // Generate filename: timestamp + sanitized original name
      const timestamp = Date.now();
      const ext = path.extname(originalName);
      const safeName = `${timestamp}${ext}`;
      const filePath = path.join(assetsPath, safeName);

      // Write the buffer to file
      await fsp.writeFile(filePath, Buffer.from(buffer));

      return safeName; // Return just the filename, not the full path
    } catch (err) {
      console.error('Failed to save asset:', err);
      throw err;
    }
  });

  // 4. List Files
  ipcMain.handle('vault:list', async () => {
    if (!activeVaultPath) return [];

    try {
      const files = await fs.readdir(activeVaultPath);

      // Filter for .md files and ignore hidden system files (like .DS_Store)
      const mdFiles = files.filter((file) => file.endsWith('.md') && !file.startsWith('.'));

      return mdFiles;
    } catch (err) {
      console.error(err);
      return [];
    }
  });
}

// Programmatically open a vault path (used on startup or from menu)
export async function openVaultPath(vaultPath: string, mainWindow: BrowserWindow): Promise<void> {
  // Stop any existing indexer before switching vaults
  try {
    stopIndexing();
  } catch (err) {
    console.warn('Error stopping previous indexer (continuing):', err);
  }

  activeVaultPath = vaultPath;

  // send cached graph if available
  try {
    const cachePath = path.join(activeVaultPath, '.phosphor', 'graph.json');
    try {
      const raw = await fsp.readFile(cachePath, 'utf-8');
      const graph = JSON.parse(raw);
      mainWindow.webContents.send('phosphor:graph-update', graph);
      console.log('Loaded cached graph from', cachePath);
      // notify UI that cached graph was loaded
      mainWindow.webContents.send('phosphor:status', {
        type: 'cache-loaded',
        message: 'Loaded cached index'
      });
    } catch {
      // no cache — that's fine
    }
  } catch (err) {
    console.error('Error checking/reading graph cache', err);
  }

  // start background indexing for this vault
  try {
    startIndexing(activeVaultPath, mainWindow);
    // persist choice
    await saveLastVault(activeVaultPath);
    // notify UI that vault opened
    try {
      mainWindow.webContents.send('phosphor:status', {
        type: 'vault-opened',
        message: `Opened vault ${path.basename(activeVaultPath)}`
      });
    } catch (e) {
      console.warn('Could not send vault-opened status', e);
    }
  } catch (err) {
    console.error(err);
    mainWindow.webContents.send('phosphor:status', {
      type: 'error',
      message: 'Indexer failed to start'
    });
  }
}

export async function getSavedVaultPath(): Promise<string | null> {
  return loadLastVault();
}

export function getActiveVaultPath(): string | null {
  return activeVaultPath;
}

import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import * as fsp from 'fs/promises';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  startIndexing,
  stopIndexing,
  getLastGraph,
  getLastTasks,
  performSearch,
  updateTasksForFile
} from './indexer';
import { setupWatcher, stopWatcher, markInternalSave } from './watcher';
import { deriveMasterKey, encryptBuffer, decryptBuffer, isEncrypted, generateSalt } from './crypto';
import sodium from 'sodium-native';

// Safe logging that ignores EPIPE errors during shutdown
const safeLog = (msg: string): void => {
  try {
    console.log(msg);
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

const safeWarn = (msg: string, err?: unknown): void => {
  try {
    console.warn(msg, err);
  } catch {
    // Ignore EPIPE errors that occur during shutdown
  }
};

// Store the active vault path in memory for this session
let activeVaultPath: string | null = null;

// Master Key is stored in process memory and cleared on app quit
// This variable is only set after successful password authentication
let activeMasterKey: Buffer | null = null;

const CONFIG_DIR = path.join(app.getPath('userData'), '.phosphor');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

async function ensureConfigDir(): Promise<void> {
  try {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
  } catch (err) {
    safeError('Failed to create config dir', err);
  }
}

async function saveLastVault(vaultPath: string): Promise<void> {
  try {
    await ensureConfigDir();
    const cfg = { lastVault: vaultPath };
    await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg), 'utf-8');
  } catch (err) {
    safeError('Failed to write config', err);
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

// ============ ENCRYPTION: Security File Management ============

interface SecurityConfig {
  salt: string; // Base64 encoded
  checkToken: string; // Base64 encoded encrypted token
}

/**
 * Get the path to the vault's security.json file
 */
function getSecurityConfigPath(vaultPath: string): string {
  return path.join(vaultPath, '.phosphor', 'security.json');
}

/**
 * Check if vault has encryption enabled
 */
export async function isEncryptionEnabled(vaultPath: string): Promise<boolean> {
  try {
    const securityPath = getSecurityConfigPath(vaultPath);
    await fsp.access(securityPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load security config from vault
 */
async function loadSecurityConfig(vaultPath: string): Promise<SecurityConfig | null> {
  try {
    const securityPath = getSecurityConfigPath(vaultPath);
    const raw = await fsp.readFile(securityPath, 'utf-8');
    return JSON.parse(raw) as SecurityConfig;
  } catch {
    return null;
  }
}

/**
 * Create a new security config with given password
 */
async function createSecurityConfig(vaultPath: string, password: string): Promise<SecurityConfig> {
  // Generate a random salt
  const salt = generateSalt();

  // Derive the master key from password
  const masterKey = deriveMasterKey(password, salt);

  // Create a check token (just a simple test string to verify password)
  const checkToken = Buffer.from('phosphor-vault-check-token');
  const encryptedCheckToken = encryptBuffer(checkToken, masterKey);

  // Clear the master key from memory after use
  sodium.sodium_memzero(masterKey);

  const config: SecurityConfig = {
    salt: salt.toString('base64'),
    checkToken: encryptedCheckToken.toString('base64')
  };

  // Save to disk
  const securityPath = getSecurityConfigPath(vaultPath);
  await fsp.mkdir(path.dirname(securityPath), { recursive: true });
  await fsp.writeFile(securityPath, JSON.stringify(config), 'utf-8');

  return config;
}

/**
 * Try to unlock vault with password
 * Returns true if successful, false if wrong password
 */
async function tryUnlockVault(vaultPath: string, password: string): Promise<boolean> {
  try {
    const config = await loadSecurityConfig(vaultPath);
    if (!config) {
      // No security config = not encrypted
      return true;
    }

    // Derive master key from password and stored salt
    const salt = Buffer.from(config.salt, 'base64');
    const masterKey = deriveMasterKey(password, salt);

    // Try to decrypt the check token
    const encryptedCheckToken = Buffer.from(config.checkToken, 'base64');
    try {
      decryptBuffer(encryptedCheckToken, masterKey);
      // Success! Store the master key for this session
      activeMasterKey = masterKey;
      safeLog('[Encryption] Vault unlocked successfully');
      return true;
    } catch {
      // Decryption failed = wrong password
      sodium.sodium_memzero(masterKey);
      safeWarn('[Encryption] Wrong password');
      return false;
    }
  } catch (err) {
    safeError('[Encryption] Error during unlock:', err);
    return false;
  }
}

/**
 * Clear the master key from memory
 */
function lockVault(): void {
  if (activeMasterKey) {
    sodium.sodium_memzero(activeMasterKey);
    activeMasterKey = null;
    safeLog('[Encryption] Vault locked');
  }
}

/**
 * Encrypt all notes in the vault
 */
async function encryptAllNotes(vaultPath: string): Promise<void> {
  if (!activeMasterKey) throw new Error('No master key available');

  try {
    const entries = await fsp.readdir(vaultPath);

    for (const entry of entries) {
      // Skip hidden files and directories except _assets
      if (entry.startsWith('.')) continue;

      const fullPath = path.join(vaultPath, entry);
      const stat = await fsp.stat(fullPath);

      if (entry === '_assets' && stat.isDirectory()) {
        // Encrypt all files in _assets folder
        try {
          const assetEntries = await fsp.readdir(fullPath);
          for (const assetFile of assetEntries) {
            const assetPath = path.join(fullPath, assetFile);
            const assetStat = await fsp.stat(assetPath);

            if (assetStat.isFile()) {
              try {
                const buffer = await fsp.readFile(assetPath);
                const encryptedBuffer = encryptBuffer(buffer, activeMasterKey);
                await fsp.writeFile(assetPath, encryptedBuffer);
                safeLog(`[Encryption] Encrypted asset: ${assetFile}`);
              } catch (err) {
                safeError(`[Encryption] Failed to encrypt asset ${assetFile}:`, err);
              }
            }
          }
        } catch (err) {
          safeError('[Encryption] Failed to process _assets folder:', err);
        }
      } else if (!entry.startsWith('_') && stat.isFile() && entry.endsWith('.md')) {
        // Encrypt markdown files
        try {
          const content = await fsp.readFile(fullPath, 'utf-8');
          const encryptedBuffer = encryptBuffer(Buffer.from(content, 'utf-8'), activeMasterKey);
          await fsp.writeFile(fullPath, encryptedBuffer);
          safeLog(`[Encryption] Encrypted: ${entry}`);
        } catch (err) {
          safeError(`[Encryption] Failed to encrypt ${entry}:`, err);
        }
      }
    }
  } catch (err) {
    safeError('[Encryption] Failed to encrypt vault:', err);
    throw err;
  }
}

/**
 * Scan vault for unencrypted files and encrypt them
 * This is a safety feature to catch files added from outside the app
 */
async function scanAndEncryptUnencryptedFiles(vaultPath: string): Promise<void> {
  if (!activeMasterKey) return; // Only run if vault is unlocked

  try {
    const entries = await fsp.readdir(vaultPath);

    for (const entry of entries) {
      // Skip hidden files and directories except _assets
      if (entry.startsWith('.')) continue;

      const fullPath = path.join(vaultPath, entry);
      const stat = await fsp.stat(fullPath);

      if (entry === '_assets' && stat.isDirectory()) {
        // Check asset files
        try {
          const assetEntries = await fsp.readdir(fullPath);
          for (const assetFile of assetEntries) {
            const assetPath = path.join(fullPath, assetFile);
            const assetStat = await fsp.stat(assetPath);

            if (assetStat.isFile()) {
              try {
                const buffer = await fsp.readFile(assetPath);

                // Try to decrypt - if it fails, the file is unencrypted
                try {
                  decryptBuffer(buffer, activeMasterKey);
                  // Decryption succeeded, file is already encrypted
                } catch {
                  // Decryption failed, file is unencrypted - encrypt it
                  const encryptedBuffer = encryptBuffer(buffer, activeMasterKey);
                  await fsp.writeFile(assetPath, encryptedBuffer);
                  safeLog(`[Encryption] Auto-encrypted unencrypted asset: ${assetFile}`);
                }
              } catch (err) {
                safeError(`[Encryption] Failed to process asset ${assetFile}:`, err);
              }
            }
          }
        } catch (err) {
          safeError('[Encryption] Failed to scan _assets folder:', err);
        }
      } else if (!entry.startsWith('_') && stat.isFile() && entry.endsWith('.md')) {
        // Check markdown files by trying to read as UTF-8
        try {
          const buffer = await fsp.readFile(fullPath);

          // Try to decrypt first
          let isEncrypted = true;
          try {
            decryptBuffer(buffer, activeMasterKey);
          } catch {
            // Decryption failed, check if it's plain UTF-8 text
            const text = buffer.toString('utf-8');
            // If it's valid UTF-8 and doesn't look like encrypted binary, it's unencrypted
            if (text && !buffer.includes(0)) {
              isEncrypted = false;
            }
          }

          if (!isEncrypted) {
            // File is unencrypted, encrypt it
            const content = buffer.toString('utf-8');
            const encryptedBuffer = encryptBuffer(Buffer.from(content, 'utf-8'), activeMasterKey);
            await fsp.writeFile(fullPath, encryptedBuffer);
            safeLog(`[Encryption] Auto-encrypted unencrypted note: ${entry}`);
          }
        } catch (err) {
          safeError(`[Encryption] Failed to process ${entry}:`, err);
        }
      }
    }
  } catch (err) {
    safeError('[Encryption] Failed to scan vault for unencrypted files:', err);
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

  // Return last in-memory tasks if available (sent recently by indexer)
  ipcMain.handle('tasks:get', async () => {
    return getLastTasks();
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
      const buffer = await fs.readFile(filePath);

      // Check if file is encrypted
      if (activeMasterKey && isEncrypted(buffer)) {
        try {
          const decrypted = decryptBuffer(buffer, activeMasterKey);
          return decrypted.toString('utf-8');
        } catch (err) {
          safeError(`[Encryption] Decryption error for ${filename}`, err);
          throw new Error('Could not decrypt file');
        }
      }

      // File is not encrypted, return as-is
      return buffer.toString('utf-8');
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
      markInternalSave(); // Mark this as an internal save to avoid false conflict detection

      // If encryption is enabled, encrypt the content before writing
      let buffer: Buffer;
      if (activeMasterKey) {
        buffer = encryptBuffer(Buffer.from(content, 'utf-8'), activeMasterKey);
      } else {
        buffer = Buffer.from(content, 'utf-8');
      }

      await fs.writeFile(filePath, buffer);
      return true;
    } catch (err) {
      safeError('Failed to save:', err);
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
      let fileBuffer: Buffer = Buffer.from(buffer);

      // If encryption is enabled, encrypt the asset
      if (activeMasterKey) {
        fileBuffer = encryptBuffer(fileBuffer, activeMasterKey) as Buffer;
      }

      await fsp.writeFile(filePath, fileBuffer);

      return safeName; // Return just the filename, not the full path
    } catch (err) {
      safeError('Failed to save asset:', err);
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
      safeError('Failed to list vault files:', err);
      return [];
    }
  });

  // 5. Delete Note
  ipcMain.handle('note:delete', async (_, filename: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    const safeName = path.basename(filename);
    const filePath = path.join(activeVaultPath, safeName);

    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      safeError('Failed to delete note:', err);
      return false;
    }
  });

  // ============ ENCRYPTION HANDLERS ============

  // Check if encryption is enabled for current vault
  ipcMain.handle('encryption:is-enabled', async () => {
    if (!activeVaultPath) return false;
    return isEncryptionEnabled(activeVaultPath);
  });

  // Unlock vault with password
  ipcMain.handle('encryption:unlock', async (_, password: string) => {
    if (!activeVaultPath) return false;
    const success = await tryUnlockVault(activeVaultPath, password);
    if (success) {
      // Scan for any unencrypted files and encrypt them
      await scanAndEncryptUnencryptedFiles(activeVaultPath);
      // Re-index vault with decrypted content
      stopIndexing();
      startIndexing(activeVaultPath, mainWindow);
    }
    return success;
  });

  // Lock vault (clear master key from memory)
  ipcMain.handle('encryption:lock', async () => {
    lockVault();
    return true;
  });

  // Check if vault is currently unlocked
  ipcMain.handle('encryption:is-unlocked', async () => {
    return activeMasterKey !== null;
  });

  // Request vault re-index (e.g., after unlocking)
  ipcMain.handle('vault:reindex', async () => {
    if (!activeVaultPath) return false;
    try {
      stopIndexing();
      startIndexing(activeVaultPath, mainWindow);
      return true;
    } catch (err) {
      safeError('[Vault] Failed to re-index:', err);
      return false;
    }
  });

  // Create encryption for vault (set password)
  ipcMain.handle('encryption:create', async (_, password: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');
    try {
      await createSecurityConfig(activeVaultPath, password);
      // Auto-unlock after creating encryption
      await tryUnlockVault(activeVaultPath, password);
      // Encrypt all existing notes in the vault
      await encryptAllNotes(activeVaultPath);
      return true;
    } catch (err) {
      safeError('[Encryption] Failed to create encryption:', err);
      return false;
    }
  });
}

// Programmatically open a vault path (used on startup or from menu)
export async function openVaultPath(vaultPath: string, mainWindow: BrowserWindow): Promise<void> {
  // Stop any existing indexer and watcher before switching vaults
  try {
    stopIndexing();
    stopWatcher();
  } catch (err) {
    safeWarn('Error stopping previous indexer/watcher (continuing):', err);
  }

  activeVaultPath = vaultPath;

  // Start file watcher for this vault
  try {
    setupWatcher(vaultPath, mainWindow, (filename) => {
      // Update tasks for only the changed file (efficient incremental update)
      updateTasksForFile(vaultPath, filename, mainWindow);
    });
  } catch (err) {
    safeError('Failed to start watcher:', err);
  }

  // send cached graph if available
  try {
    const cachePath = path.join(activeVaultPath, '.phosphor', 'graph.json');
    try {
      const raw = await fsp.readFile(cachePath, 'utf-8');
      const graph = JSON.parse(raw);
      // Only send if window is still valid
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phosphor:graph-update', graph);
      }
      safeLog('Loaded cached graph from ' + cachePath);
      // notify UI that cached graph was loaded
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phosphor:status', {
          type: 'cache-loaded',
          message: 'Loaded cached index'
        });
      }
    } catch {
      // no cache — that's fine
    }
  } catch (err) {
    safeError('Error checking/reading graph cache', err);
  }

  // start background indexing for this vault
  try {
    startIndexing(activeVaultPath, mainWindow);
    // persist choice
    await saveLastVault(activeVaultPath);
    // notify UI that vault opened
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phosphor:status', {
          type: 'vault-opened',
          message: `Opened vault ${path.basename(activeVaultPath)}`
        });
      }
    } catch (e) {
      safeWarn('Could not send vault-opened status', e);
    }
  } catch (err) {
    safeError('Indexer error:', err);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('phosphor:status', {
        type: 'error',
        message: 'Indexer failed to start'
      });
    }
  }
}

export async function getSavedVaultPath(): Promise<string | null> {
  return loadLastVault();
}

export function getActiveVaultPath(): string | null {
  return activeVaultPath;
}

export function getActiveMasterKey(): Buffer | null {
  return activeMasterKey;
}

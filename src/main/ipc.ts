import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import {
  startIndexing,
  stopIndexing,
  getLastGraph,
  getLastTasks,
  getLastPredictionModelSerialized,
  performSearch,
  schedulePredictionModelUpdate,
  updateTasksForFile,
  updateGraphForFile,
  updateGraphForChangedFile,
  resetIndexState
} from './indexer';
import { getBacklinks, getGraphStats } from './graphBuilder';
import { setupWatcher, stopWatcher, markInternalSave } from './watcher';
import { deriveMasterKey, encryptBuffer, decryptBuffer, isEncrypted, generateSalt } from './crypto';
import {
  initializeMRU,
  getMRUFiles,
  updateMRU,
  removeFromMRU,
  getFavorites,
  toggleFavorite
} from './store';
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

// Store mainWindow reference for sending updates
let mainWindow: BrowserWindow | null = null;

/**
 * Safely resolve a filename relative to the vault, preventing directory traversal attacks.
 * Allows nested paths like "People/John.md" but rejects "../../../etc/passwd"
 */
function validateAndResolvePath(vaultPath: string, filename: string): string {
  // Resolve both paths to absolute to compare them properly
  const resolvedVault = path.resolve(vaultPath);
  const resolvedPath = path.resolve(vaultPath, filename);

  // Ensure resolved path is within vault directory
  if (!resolvedPath.startsWith(resolvedVault + path.sep) && resolvedPath !== resolvedVault) {
    throw new Error('Path traversal attempt detected');
  }

  return resolvedPath;
}

/**
 * Auto-create parent files for nested paths.
 * For example, if creating People/John/Notes.md, also creates:
 * - People.md
 * - People/John.md
 * Returns true if any parent files were created
 */
async function ensureParentFilesExist(vaultPath: string, filePath: string): Promise<boolean> {
  const relativePath = filePath.substring(vaultPath.length + 1).replace(/\\/g, '/');
  const parts = relativePath.split('/');

  // Don't process if it's a top-level file (no slashes)
  if (parts.length <= 1) return false;

  let anyCreated = false;

  // Create parent files for each level (except the last one, which is the file itself)
  for (let i = 1; i < parts.length; i++) {
    const parentPath = parts.slice(0, i).join('/') + '.md';
    const parentFilePath = path.join(vaultPath, parentPath);

    try {
      // Check if parent file already exists
      await fsp.access(parentFilePath);
      // File exists, continue
    } catch {
      // File doesn't exist, create it
      try {
        let buffer: Buffer;
        if (activeMasterKey) {
          // If vault is encrypted, encrypt the empty file
          buffer = encryptBuffer(Buffer.from('', 'utf-8'), activeMasterKey);
        } else {
          // Otherwise, write as plain text
          buffer = Buffer.from('', 'utf-8');
        }
        await fsp.writeFile(parentFilePath, buffer);
        safeLog(`[Auto-create] Created parent file: ${parentPath}`);
        anyCreated = true;
      } catch (err) {
        safeError(`[Auto-create] Failed to create parent file ${parentPath}:`, err);
      }
    }
  }

  return anyCreated;
}

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
 * Recursively handles nested directories
 */
async function scanAndEncryptUnencryptedFiles(vaultPath: string): Promise<void> {
  if (!activeMasterKey) return; // Only run if vault is unlocked

  const masterKey = activeMasterKey; // Type guard: activeMasterKey is non-null in this scope

  try {
    // Recursively process all files in the vault
    async function processDirectory(dir: string): Promise<void> {
      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files and directories
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Special handling for _assets folder
          if (entry.name === '_assets') {
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
                      decryptBuffer(buffer, masterKey);
                      // Decryption succeeded, file is already encrypted
                    } catch {
                      // Decryption failed, file is unencrypted - encrypt it
                      const encryptedBuffer = encryptBuffer(buffer, masterKey);
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
          } else if (!entry.name.startsWith('_')) {
            // Recurse into other non-hidden, non-underscore directories
            await processDirectory(fullPath);
          }
        } else if (!entry.name.startsWith('_') && entry.name.endsWith('.md')) {
          // Check markdown files by trying to read as UTF-8
          try {
            const buffer = await fsp.readFile(fullPath);

            // Try to decrypt first
            let isEncrypted = true;
            try {
              decryptBuffer(buffer, masterKey);
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
              const encryptedBuffer = encryptBuffer(Buffer.from(content, 'utf-8'), masterKey);
              await fsp.writeFile(fullPath, encryptedBuffer);
              safeLog(`[Encryption] Auto-encrypted unencrypted note: ${entry.name}`);
            }
          } catch (err) {
            safeError(`[Encryption] Failed to process ${entry.name}:`, err);
          }
        }
      }
    }

    await processDirectory(vaultPath);
  } catch (err) {
    safeError('[Encryption] Failed to encrypt vault:', err);
    throw err;
  }
}

export function setupIPC(mainWindowArg: BrowserWindow): void {
  // Store mainWindow reference for use in handlers
  mainWindow = mainWindowArg;

  // 1. Select Vault
  ipcMain.handle('vault:select', async () => {
    // Delegate to the dialog-based opener
    const result = await dialog.showOpenDialog(mainWindowArg, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Phosphor Vault',
      buttonLabel: 'Open Vault'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const chosen = result.filePaths[0];
    if (mainWindow) {
      await openVaultPath(chosen, mainWindow);
    }
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

  // Return graph statistics
  ipcMain.handle('graph:stats', async () => {
    const graph = getLastGraph();
    if (!graph) {
      return {
        totalFiles: 0,
        totalLinks: 0,
        avgLinksPerFile: 0,
        isolatedFiles: 0,
        cycles: 0,
        mostLinked: []
      };
    }
    return getGraphStats(graph);
  });

  ipcMain.handle('prediction:get', async () => {
    return getLastPredictionModelSerialized();
  });

  // Handle graph update for a file (called when leaving a file to update its outgoing links)
  ipcMain.handle('graph:update-file', async (_, filename: string) => {
    if (!activeVaultPath || !mainWindow) {
      return;
    }

    const normalize = (name: string): string => {
      const trimmed = (name || '').trim();
      if (!trimmed) return '';
      return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    };

    const normalizedFilename = normalize(filename);

    if (!normalizedFilename) {
      safeWarn('Graph update requested with empty filename');
      return;
    }

    try {
      // Update graph for the file being left (captures its current outgoing links)
      await updateGraphForChangedFile(activeVaultPath, normalizedFilename, mainWindow);
    } catch (err) {
      safeError('Failed to update graph for file:', err);
    }
  });

  // Handle task update for a file (called when leaving a file to update its task index)
  ipcMain.handle('tasks:update-file', async (_, filename: string) => {
    if (!activeVaultPath || !mainWindow) {
      return;
    }

    const normalize = (name: string): string => {
      const trimmed = (name || '').trim();
      if (!trimmed) return '';
      return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    };

    const normalizedFilename = normalize(filename);

    if (!normalizedFilename) {
      safeWarn('Task update requested with empty filename');
      return;
    }

    try {
      // Update tasks for the file being left (captures its current task list)
      await updateTasksForFile(activeVaultPath, normalizedFilename, mainWindow);
    } catch (err) {
      safeError('Failed to update tasks for file:', err);
    }
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

  // URL opening handler - opens URLs in the default browser
  ipcMain.handle('url:open', async (_, urlString: string) => {
    try {
      // Validate that the URL starts with a protocol
      if (!/^(https?:\/\/|ftp:\/\/)/.test(urlString)) {
        throw new Error('Invalid URL - must start with http://, https://, or ftp://');
      }
      await shell.openExternal(urlString);
    } catch (error) {
      safeError('Failed to open URL:', error);
      throw error;
    }
  });

  // Menu action trigger handler - converts menu trigger actions to webContents.send calls
  ipcMain.on('menu:trigger-action', (_, action: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(action);
    }
  });

  // 2. Read Note
  ipcMain.handle('note:read', async (_, filename: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    // Security: Validate path to prevent directory traversal while allowing nested paths
    const filePath = validateAndResolvePath(activeVaultPath, filename);

    try {
      const buffer = await fsp.readFile(filePath);

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
        // Ensure parent directories exist for nested files
        const dir = path.dirname(filePath);
        await fsp.mkdir(dir, { recursive: true });
        // Auto-create parent .md files and check if we created any
        const parentFilesCreated = await ensureParentFilesExist(activeVaultPath, filePath);
        await fsp.writeFile(filePath, ''); // Create empty file

        // If we created parent files, trigger a graph re-index
        if (parentFilesCreated && mainWindow && !mainWindow.isDestroyed()) {
          safeLog('[Auto-create] Triggering graph re-index due to parent file creation');
          const mw = mainWindow; // Type-narrow mainWindow for TS type safety
          stopIndexing();
          startIndexing(activeVaultPath, mw);
        }

        return '';
      }
      throw err;
    }
  });

  // 3. Save Note
  ipcMain.handle('note:save', async (_, filename: string, content: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    // Security: Validate path to prevent directory traversal while allowing nested paths
    const filePath = validateAndResolvePath(activeVaultPath, filename);

    // Ensure parent directories exist for nested files
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    // Auto-create parent .md files and check if we created any
    const parentFilesCreated = await ensureParentFilesExist(activeVaultPath, filePath);

    try {
      markInternalSave(); // Mark this as an internal save to avoid false conflict detection

      // --- Backup guard: if new content is >10% smaller, copy existing file first
      try {
        const existingBuffer = await fsp.readFile(filePath);
        let existingLength = existingBuffer.length;

        // If encrypted, try to compare plaintext sizes for a better signal
        if (activeMasterKey && isEncrypted(existingBuffer)) {
          try {
            const decrypted = decryptBuffer(existingBuffer, activeMasterKey);
            existingLength = Buffer.byteLength(decrypted, 'utf-8');
          } catch {
            // Fall back to ciphertext size if decryption fails
          }
        } else {
          existingLength = Buffer.byteLength(existingBuffer.toString('utf-8'), 'utf-8');
        }

        const nextLength = Buffer.byteLength(content, 'utf-8');
        const isShrink = existingLength > 0 && nextLength < existingLength * 0.9;

        if (isShrink) {
          const parsed = path.parse(filePath);
          const backupName = `${parsed.name}.${Date.now()}${parsed.ext}.bak`;
          const backupPath = path.join(parsed.dir, backupName);
          try {
            await fsp.writeFile(backupPath, existingBuffer);
            safeLog(`[Backup] Created ${backupName} before shrink-save`);
          } catch (backupErr) {
            safeWarn('[Backup] Failed to create shrink backup', backupErr);
          }
        }
      } catch {
        // If file does not exist or can't be read, skip backup
      }

      // If encryption is enabled, encrypt the content before writing
      let buffer: Buffer;
      if (activeMasterKey) {
        buffer = encryptBuffer(Buffer.from(content, 'utf-8'), activeMasterKey);
      } else {
        buffer = Buffer.from(content, 'utf-8');
      }

      await fsp.writeFile(filePath, buffer);

      // If we created parent files, trigger a graph re-index
      if (parentFilesCreated && mainWindow && !mainWindow.isDestroyed()) {
        safeLog('[Auto-create] Triggering graph re-index due to parent file creation');
        const mw = mainWindow; // Type-narrow mainWindow for TS type safety
        stopIndexing();
        startIndexing(activeVaultPath, mw);
      }

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

      // Generate filename: <sanitised-original>.<timestamp>.<ext>
      const parsedOriginal = path.parse(path.basename(originalName || ''));
      let baseName = parsedOriginal.name || '';
      // Normalize: replace spaces with hyphens, remove unsafe chars, lowercase, limit length
      baseName = baseName
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9-_]/g, '')
        .toLowerCase();
      if (baseName.length > 64) baseName = baseName.slice(0, 64);
      if (!baseName) baseName = 'asset';

      const timestamp = Date.now();
      const ext = path.extname(originalName) || '';
      const safeName = `${baseName}.${timestamp}${ext}`;
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

  // Open asset in the system default application
  ipcMain.handle('asset:open', async (_event, filename: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    const assetsPath = path.join(activeVaultPath, '_assets');
    const normalizedAssetsPath = path.resolve(assetsPath);
    const targetPath = path.resolve(assetsPath, filename);

    // Prevent path traversal outside _assets
    if (!targetPath.startsWith(normalizedAssetsPath + path.sep)) {
      safeWarn('[Asset] Attempted access outside _assets:', filename);
      return false;
    }

    try {
      const buffer = await fsp.readFile(targetPath);

      // If encrypted, decrypt to a temporary file before opening
      if (activeMasterKey && isEncrypted(buffer)) {
        try {
          const decrypted = decryptBuffer(buffer, activeMasterKey);
          const tempDir = path.join(app.getPath('temp'), 'phosphor-assets');
          await fsp.mkdir(tempDir, { recursive: true });
          const tempPath = path.join(tempDir, path.basename(filename));
          await fsp.writeFile(tempPath, decrypted);
          const result = await shell.openPath(tempPath);
          if (result) {
            safeError('[Asset] Failed to open decrypted asset:', result);
            return false;
          }
          return true;
        } catch (err) {
          safeError('[Asset] Failed to decrypt asset for opening:', err);
          return false;
        }
      }

      // Not encrypted — open directly
      const result = await shell.openPath(targetPath);
      if (result) {
        safeError('[Asset] Failed to open asset:', result);
        return false;
      }
      return true;
    } catch (err) {
      safeError('[Asset] Failed to open asset:', err);
      return false;
    }
  });

  // 4. List Files
  ipcMain.handle('vault:list', async () => {
    if (!activeVaultPath) return [];

    try {
      const mdFiles: string[] = [];

      // Recursively find all .md files in the vault
      async function findMdFiles(dir: string, relativePrefix: string = ''): Promise<void> {
        const entries = await fsp.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip hidden files and directories except _assets (we don't list assets)
          if (entry.name.startsWith('.')) continue;

          const fullPath = path.join(dir, entry.name);
          const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            // Recurse into subdirectories
            await findMdFiles(fullPath, relativePath);
          } else if (entry.name.endsWith('.md')) {
            // Add markdown file with relative path preserved
            mdFiles.push(relativePath);
          }
        }
      }

      await findMdFiles(activeVaultPath);
      return mdFiles;
    } catch (err) {
      safeError('Failed to list vault files:', err);
      return [];
    }
  });

  // 4b. Get MRU (Most Recently Used) Files
  ipcMain.handle('vault:mru', async () => {
    if (!activeVaultPath) return [];
    return getMRUFiles(activeVaultPath);
  });

  // 4c. Update MRU list when a file is accessed
  ipcMain.handle('vault:update-mru', async (_, filename: string) => {
    if (!activeVaultPath) return [];
    return updateMRU(activeVaultPath, filename);
  });

  // Favorites handlers
  ipcMain.handle('favorites:get', async () => {
    if (!activeVaultPath) return [];
    return getFavorites(activeVaultPath);
  });

  ipcMain.handle('favorites:toggle', async (_, filename: string) => {
    if (!activeVaultPath) return [];
    const updated = await toggleFavorite(activeVaultPath, filename);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phosphor:favorites-updated', updated);
      }
    } catch (err) {
      safeWarn('Failed to send favorites-updated event', err);
    }
    return updated;
  });

  // 5. Delete Note
  ipcMain.handle('note:delete', async (_, filename: string) => {
    if (!activeVaultPath) throw new Error('No vault selected');

    // Security: Validate path to prevent directory traversal while allowing nested paths
    const filePath = validateAndResolvePath(activeVaultPath, filename);
    // Normalize filename for MRU and renderer notifications (ensure .md)
    const normalized =
      filename && filename.trim()
        ? filename.trim().endsWith('.md')
          ? filename.trim()
          : `${filename.trim()}.md`
        : '';

    try {
      // Try to move to system Trash first; fall back to unlink if it fails
      try {
        await shell.trashItem(filePath);
      } catch (e) {
        safeWarn('trashItem failed, falling back to unlink:', e);
        await fsp.unlink(filePath);
      }

      // Notify renderer that the file was deleted
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('vault:file-deleted', normalized);
        }
      } catch (err) {
        safeWarn('Failed to send vault:file-deleted after delete', err);
      }

      // Remove from MRU so it doesn't appear in recent lists
      try {
        await removeFromMRU(activeVaultPath, normalized);
      } catch (err) {
        safeWarn('Failed to remove deleted file from MRU', err);
      }

      return true;
    } catch (err) {
      safeError('Failed to delete note:', err);
      return false;
    }
  });

  // Move note: choose a destination folder within the vault and update backlinks
  ipcMain.handle('note:move', async (_, filename: string) => {
    if (!activeVaultPath || !mainWindow) throw new Error('No vault selected');

    const normalized =
      filename && filename.trim()
        ? filename.trim().endsWith('.md')
          ? filename.trim()
          : `${filename.trim()}.md`
        : '';
    if (!normalized) throw new Error('Invalid filename');

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select destination folder in vault',
      defaultPath: activeVaultPath,
      buttonLabel: 'Move Here'
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const chosen = result.filePaths[0];
    const resolvedVault = path.resolve(activeVaultPath);
    const resolvedChosen = path.resolve(chosen);
    if (!resolvedChosen.startsWith(resolvedVault + path.sep) && resolvedChosen !== resolvedVault) {
      throw new Error('Destination must be inside the current vault');
    }

    const relativeDest = path.relative(resolvedVault, resolvedChosen).replace(/\\/g, '/');
    const destPrefix = relativeDest ? `${relativeDest}/` : '';
    const baseName = path.basename(normalized);
    const newRelative = `${destPrefix}${baseName}`;

    if (newRelative === normalized) return normalized;

    const srcPath = validateAndResolvePath(activeVaultPath, normalized);
    const targetPath = validateAndResolvePath(activeVaultPath, newRelative);

    // Ensure target dir exists
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });

    // Update backlinks using in-memory graph
    try {
      const graph = getLastGraph();
      const backlinks = graph ? getBacklinks(graph, normalized) : [];

      const escapeForRegex = (s: string): string => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const oldNoExt = normalized.replace(/\.md$/i, '');
      const newNoExt = newRelative.replace(/\.md$/i, '');
      const wikiRegex = new RegExp(
        `\\[\\[\\s*(${escapeForRegex(oldNoExt)})(?:\\.md)?(\\|[^\\]]*)?\\s*\\]\\]`,
        'g'
      );

      for (const back of backlinks) {
        try {
          const backPath = validateAndResolvePath(activeVaultPath, back);
          const buffer = await fsp.readFile(backPath);
          let contentStr: string;
          if (activeMasterKey && isEncrypted(buffer)) {
            try {
              const decrypted = decryptBuffer(buffer, activeMasterKey);
              contentStr = decrypted.toString('utf-8');
            } catch {
              contentStr = buffer.toString('utf-8');
            }
          } else {
            contentStr = buffer.toString('utf-8');
          }

          const newContent = contentStr.replace(wikiRegex, (_m, _p1, p2) => {
            const alias = p2 || '';
            return `[[${newNoExt}${alias}]]`;
          });

          if (newContent !== contentStr) {
            let outBuf: Buffer;
            if (activeMasterKey) {
              outBuf = encryptBuffer(Buffer.from(newContent, 'utf-8'), activeMasterKey);
            } else {
              outBuf = Buffer.from(newContent, 'utf-8');
            }
            await fsp.writeFile(backPath, outBuf);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('vault:file-changed', back);
            }
            try {
              await updateGraphForChangedFile(activeVaultPath, back, mainWindow);
              await updateTasksForFile(activeVaultPath, back, mainWindow);
            } catch (err) {
              safeWarn('Failed to update graph/tasks for backlink after move', err);
            }
          }
        } catch (err) {
          safeWarn('Failed to update backlink file during move:', err);
        }
      }
    } catch (err) {
      safeWarn('Failed to update backlinks during move:', err);
    }

    // Perform move
    try {
      try {
        await fsp.access(targetPath);
        const overwrite = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 1,
          message: `${newRelative} already exists. Overwrite?`
        });
        if (overwrite.response !== 0) return false;
      } catch {
        // target doesn't exist
      }

      await fsp.rename(srcPath, targetPath);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vault:file-deleted', normalized);
        mainWindow.webContents.send('vault:file-added', newRelative);
      }

      try {
        await updateGraphForFile(activeVaultPath, newRelative, mainWindow);
        await updateTasksForFile(activeVaultPath, newRelative, mainWindow);
      } catch (err) {
        safeWarn('Failed to update graph/tasks for moved file', err);
      }

      // Remove old file from MRU so user doesn't accidentally recreate it
      try {
        await removeFromMRU(activeVaultPath, normalized);
      } catch (err) {
        safeWarn('Failed to remove old file from MRU after move', err);
      }

      return newRelative;
    } catch (err) {
      safeError('Failed to move file:', err);
      return false;
    }
  });

  // Rename note: update links, rename file within vault
  ipcMain.handle('note:rename', async (_, oldFilename: string, newFilename: string) => {
    if (!activeVaultPath || !mainWindow) throw new Error('No vault selected');

    const normalizedOld =
      oldFilename && oldFilename.trim()
        ? oldFilename.trim().endsWith('.md')
          ? oldFilename.trim()
          : `${oldFilename.trim()}.md`
        : '';
    const normalizedNew =
      newFilename && newFilename.trim()
        ? newFilename.trim().endsWith('.md')
          ? newFilename.trim()
          : `${newFilename.trim()}.md`
        : '';
    if (!normalizedOld || !normalizedNew) throw new Error('Invalid filename(s)');

    if (normalizedOld === normalizedNew) return normalizedNew;

    const srcPath = validateAndResolvePath(activeVaultPath, normalizedOld);
    const targetPath = validateAndResolvePath(activeVaultPath, normalizedNew);

    // Ensure target dir exists
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });

    // Update backlinks using in-memory graph
    try {
      const graph = getLastGraph();
      const backlinks = graph ? getBacklinks(graph, normalizedOld) : [];

      const escapeForRegex = (s: string): string => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const oldNoExt = normalizedOld.replace(/\.md$/i, '');
      const newNoExt = normalizedNew.replace(/\.md$/i, '');
      const wikiRegex = new RegExp(
        `\\[\\[\\s*(${escapeForRegex(oldNoExt)})(?:\\.md)?(\\|[^\\]]*)?\\s*\\]\\]`,
        'g'
      );

      for (const back of backlinks) {
        try {
          const backPath = validateAndResolvePath(activeVaultPath, back);
          const buffer = await fsp.readFile(backPath);
          let contentStr: string;
          if (activeMasterKey && isEncrypted(buffer)) {
            try {
              const decrypted = decryptBuffer(buffer, activeMasterKey);
              contentStr = decrypted.toString('utf-8');
            } catch {
              contentStr = buffer.toString('utf-8');
            }
          } else {
            contentStr = buffer.toString('utf-8');
          }

          const newContent = contentStr.replace(wikiRegex, (_m, _p1, p2) => {
            const alias = p2 || '';
            return `[[${newNoExt}${alias}]]`;
          });

          if (newContent !== contentStr) {
            let outBuf: Buffer;
            if (activeMasterKey) {
              outBuf = encryptBuffer(Buffer.from(newContent, 'utf-8'), activeMasterKey);
            } else {
              outBuf = Buffer.from(newContent, 'utf-8');
            }
            await fsp.writeFile(backPath, outBuf);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('vault:file-changed', back);
            }
            try {
              await updateGraphForChangedFile(activeVaultPath, back, mainWindow);
              await updateTasksForFile(activeVaultPath, back, mainWindow);
            } catch (err) {
              safeWarn('Failed to update graph/tasks for backlink after rename', err);
            }
          }
        } catch (err) {
          safeWarn('Failed to update backlink file during rename:', err);
        }
      }
    } catch (err) {
      safeWarn('Failed to update backlinks during rename:', err);
    }

    // Perform rename
    try {
      try {
        await fsp.access(targetPath);
        const overwrite = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 1,
          message: `${normalizedNew} already exists. Overwrite?`
        });
        if (overwrite.response !== 0) return false;
      } catch {
        // target doesn't exist
      }

      await fsp.rename(srcPath, targetPath);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vault:file-deleted', normalizedOld);
        mainWindow.webContents.send('vault:file-added', normalizedNew);
      }

      try {
        await updateGraphForFile(activeVaultPath, normalizedNew, mainWindow);
        await updateTasksForFile(activeVaultPath, normalizedNew, mainWindow);
      } catch (err) {
        safeWarn('Failed to update graph/tasks for renamed file', err);
      }

      // Update MRU: remove old and add new
      try {
        await removeFromMRU(activeVaultPath, normalizedOld);
        await updateMRU(activeVaultPath, normalizedNew);
      } catch (err) {
        safeWarn('Failed to update MRU after rename', err);
      }

      return normalizedNew;
    } catch (err) {
      safeError('Failed to rename file:', err);
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
      if (mainWindow) {
        startIndexing(activeVaultPath, mainWindow);
      }
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
      if (mainWindow) {
        const mw = mainWindow;
        startIndexing(activeVaultPath, mw);
      }
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

  // ============ IMPORT HANDLERS ============

  // Import Logseq graph
  ipcMain.handle('import:logseq', async () => {
    if (!activeVaultPath) {
      return { success: false, error: 'No vault selected' };
    }

    try {
      // Show file dialog to select Logseq vault directory
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        message: 'Select your Logseq Vault directory',
        title: 'Import Logseq Vault'
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No directory selected' };
      }

      const sourceDir = result.filePaths[0];

      // Notify UI that import is starting
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phosphor:status', {
          type: 'import-starting',
          message: 'Starting Logseq import...'
        });
      }

      // Start the import in a worker thread
      return new Promise((resolve) => {
        let worker: Worker | null = null;
        const workerPath = path.join(__dirname, 'worker', 'importer.js');

        // Helper to start the worker
        async function startWorker(): Promise<void> {
          if (fs.existsSync(workerPath)) {
            // Normal: run compiled worker
            worker = new Worker(workerPath);
          } else {
            // Fallback for dev: transpile the TS source at runtime and run via eval
            const possibleSrc = path.resolve(process.cwd(), 'src', 'main', 'worker', 'importer.ts');
            if (fs.existsSync(possibleSrc)) {
              try {
                safeLog('Import: compiled worker missing, using runtime TS fallback');
                const tsCode = fs.readFileSync(possibleSrc, 'utf-8');
                // Transpile with Typescript at runtime to CommonJS
                const ts = await import('typescript');
                const transpiled = ts.transpileModule(tsCode, {
                  compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2020
                  }
                }).outputText;

                // Start worker from transpiled code using eval
                worker = new Worker(transpiled, { eval: true });
              } catch (err) {
                throw new Error(`Failed to start importer worker: ${String(err)}`);
              }
            } else {
              throw new Error(
                `Importer worker not found at ${workerPath} and source fallback not available`
              );
            }
          }

          if (!worker) {
            throw new Error('Failed to create worker');
          }

          // Handle messages from worker
          worker.on('message', (message: { type: string; [key: string]: unknown }) => {
            if (message.type === 'progress') {
              const progress = message as {
                type: string;
                current: number;
                total: number;
                currentFile: string;
              };
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('phosphor:import-progress', {
                  current: progress.current,
                  total: progress.total,
                  currentFile: progress.currentFile
                });
              }
            } else if (message.type === 'success') {
              const success = message as {
                type: string;
                filesImported: number;
                assetsImported: number;
              };
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('phosphor:status', {
                  type: 'import-success',
                  message: `Imported ${success.filesImported} files and ${success.assetsImported} assets`
                });
              }

              // Re-index the vault to pick up the new files
              try {
                stopIndexing();
                if (activeVaultPath && mainWindow && !mainWindow.isDestroyed()) {
                  startIndexing(activeVaultPath, mainWindow);
                }
              } catch (err) {
                safeError('Failed to re-index after import:', err);
              }

              worker?.terminate();
              resolve({ success: true, filesImported: success.filesImported });
            } else if (message.type === 'error') {
              const error = message as { type: string; message: string };
              safeError('Import error:', error.message);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('phosphor:status', {
                  type: 'import-error',
                  message: `Import failed: ${error.message}`
                });
              }
              worker?.terminate();
              resolve({ success: false, error: error.message });
            }
          });

          // Handle worker errors
          worker.on('error', (err: Error) => {
            safeError('Worker error:', err);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('phosphor:status', {
                type: 'import-error',
                message: `Worker error: ${err.message}`
              });
            }
            worker?.terminate();
            resolve({ success: false, error: err.message });
          });

          // Handle worker exit
          worker.on('exit', (code: number) => {
            if (code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('phosphor:status', {
                type: 'import-error',
                message: `Worker exited with code ${code}`
              });
            }
          });

          // Send the import request to the worker
          worker.postMessage({
            sourceDir: sourceDir,
            targetDir: activeVaultPath
          });
        }

        startWorker().catch((err) => {
          safeError('Failed to start import worker:', err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('phosphor:status', {
              type: 'import-error',
              message: `Failed to start import: ${String(err)}`
            });
          }
          resolve({ success: false, error: String(err) });
        });
      });
    } catch (err) {
      safeError('Import handler error:', err);
      return { success: false, error: String(err) };
    }
  });

  // Get app versions
  ipcMain.handle('app:get-versions', async () => {
    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      app: app.getVersion()
    };
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

  // Clear any encryption master key and reset in-memory indexer state
  try {
    lockVault();
  } catch (err) {
    safeWarn('Failed to clear master key during vault switch:', err);
  }

  try {
    resetIndexState(mainWindow);
    // Also clear favorites in renderer so UI doesn't show previous vault's list
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('phosphor:favorites-updated', []);
    }
  } catch (err) {
    safeWarn('Failed to reset in-memory indexer state during vault switch:', err);
  }

  activeVaultPath = vaultPath;

  // Initialize MRU for this vault
  try {
    await initializeMRU(vaultPath);
  } catch (err) {
    safeWarn('Error initializing MRU:', err);
  }

  // Start file watcher for this vault
  try {
    setupWatcher(
      vaultPath,
      mainWindow,
      (filename) => {
        // Update tasks for only the changed file (efficient incremental update)
        updateTasksForFile(vaultPath, filename, mainWindow);
        schedulePredictionModelUpdate(vaultPath, filename, mainWindow);
      },
      (filename) => {
        // Update graph for newly added files (efficient incremental update)
        updateGraphForFile(vaultPath, filename, mainWindow);
        schedulePredictionModelUpdate(vaultPath, filename, mainWindow);
      },
      (filename) => {
        // Drop prediction stats for deleted files
        schedulePredictionModelUpdate(vaultPath, filename, mainWindow);
      }
    );
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
        // Inform renderer that a new vault was opened so it can reload UI state
        mainWindow.webContents.send('phosphor:vault-opened', path.basename(activeVaultPath));
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

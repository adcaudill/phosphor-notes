import { app, shell, BrowserWindow, protocol, ipcMain, screen, Menu } from 'electron';
import { join, extname } from 'path';
import { readFile } from 'fs/promises';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import {
  setupIPC,
  getSavedVaultPath,
  openVaultPath,
  getActiveVaultPath,
  getActiveMasterKey
} from './ipc';
import { createMenu } from './menu';
import { setupSettingsHandlers, initializeSettings, updateSettings } from './store';
import type { UserSettings } from '../types/phosphor.d';
import { decryptBuffer, isEncrypted } from './crypto';

// Suppress EPIPE errors that occur when trying to write to stdout/stderr during shutdown
// This prevents "write EPIPE" errors when the process is closing
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') {
    console.error('Unexpected stdout error:', err);
  }
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') {
    console.error('Unexpected stderr error:', err);
  }
});

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
    case '.svgz':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

// Custom protocol for secure asset serving
function setupProtocol(): void {
  protocol.handle('phosphor', async (request) => {
    const vaultPath = getActiveVaultPath();
    if (!vaultPath) {
      return new Response('No vault active', { status: 404 });
    }

    // Strip the protocol and get the file path relative to vault. Decode any
    // percent-encoding the renderer may have added, and strip leading
    // slashes so `path.join` treats it as a relative path into `_assets`.
    const raw = request.url.slice('phosphor://'.length);
    const decoded = decodeURIComponent(raw);
    // Remove leading slashes and any query/hash fragments (used for PDF viewer params)
    const sanitizedPath = decoded.replace(/^\/+/, '').split(/[?#]/)[0];

    // Security: Ensure the path is within the vault and _assets folder
    const fullPath = join(vaultPath, '_assets', sanitizedPath);
    const normalized = join(fullPath);
    const vaultAssetsPath = join(vaultPath, '_assets');

    // Ensure the resolved path is within _assets
    if (!normalized.startsWith(vaultAssetsPath)) {
      return new Response('Access denied', { status: 403 });
    }

    try {
      // Read the file as a buffer
      const buffer = await readFile(normalized);

      // Detect mime type up-front so both encrypted and plain responses share it
      const mimeType = getMimeType(sanitizedPath);
      const headers = { 'content-type': mimeType };

      // Check if file is encrypted and decrypt if needed
      const masterKey = getActiveMasterKey();
      if (masterKey && isEncrypted(buffer)) {
        try {
          const decrypted = decryptBuffer(buffer, masterKey);
          return new Response(new Uint8Array(decrypted), { headers });
        } catch (err) {
          console.error('Failed to decrypt asset:', sanitizedPath, err);
          return new Response('Decryption failed', { status: 500 });
        }
      }

      // File is not encrypted, return as-is
      return new Response(new Uint8Array(buffer), { headers });
    } catch (err) {
      console.error('Failed to serve asset:', sanitizedPath, err);
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow(settings?: UserSettings): BrowserWindow {
  // Create the browser window. Use persisted bounds if present, but
  // constrain them to the display work area so windows don't appear off-screen.
  const bounds = settings?.windowBounds;

  let initialOpts: { width: number; height: number; x?: number; y?: number } = {
    width: 1100,
    height: 800
  };

  if (bounds) {
    // Find the display that best matches the previous bounds
    const matchRect = {
      x: bounds.x ?? 0,
      y: bounds.y ?? 0,
      width: bounds.width,
      height: bounds.height
    };
    const disp = screen.getDisplayMatching(matchRect);
    const wa = disp.workArea; // { x, y, width, height }

    // Clamp width/height to work area size
    const w = Math.min(bounds.width, wa.width);
    const h = Math.min(bounds.height, wa.height);

    // Default to previous x/y when available, otherwise center on work area
    let x = typeof bounds.x === 'number' ? bounds.x : wa.x + Math.floor((wa.width - w) / 2);
    let y = typeof bounds.y === 'number' ? bounds.y : wa.y + Math.floor((wa.height - h) / 2);

    // Ensure the window is fully within the work area
    const maxX = wa.x + wa.width - w;
    const maxY = wa.y + wa.height - h;
    if (x < wa.x) x = wa.x;
    if (y < wa.y) y = wa.y;
    if (x > maxX) x = Math.max(wa.x, maxX);
    if (y > maxY) y = Math.max(wa.y, maxY);

    initialOpts = { width: w, height: h, x, y };
  }

  const mainWindow = new BrowserWindow({
    width: initialOpts.width,
    height: initialOpts.height,
    x: initialOpts.x,
    y: initialOpts.y,
    show: false,
    autoHideMenuBar: true,
    // macOS native window styling
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
    visualEffectState: 'active',
    backgroundColor: '#00000000', // Transparent background for vibrancy effect
    trafficLightPosition: process.platform === 'darwin' ? { x: 15, y: 12 } : undefined,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: true
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // Setup context menu with standard editing options
  mainWindow.webContents.on('context-menu', async (_event, params: Electron.ContextMenuParams) => {
    const template: Electron.MenuItemConstructorOptions[] = [];

    // Spell check options first (macOS convention)
    if (params.misspelledWord) {
      // Add spelling suggestions
      if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
        params.dictionarySuggestions.forEach((suggestion) => {
          template.push({
            label: suggestion,
            click: () => {
              mainWindow.webContents.replaceMisspelling(suggestion);
            }
          });
        });
      }

      // Add Ignore and Learn spelling options
      if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
        template.push({ type: 'separator' });
      }

      template.push({
        label: 'Ignore Spelling',
        click: () => {
          const wcSession = mainWindow.webContents.session as unknown as {
            spellCheckerDictionary?: { addWord(word: string): void };
          };
          wcSession.spellCheckerDictionary?.addWord(params.misspelledWord);
        }
      });

      template.push({
        label: 'Learn Spelling',
        click: () => {
          const wcSession = mainWindow.webContents.session as unknown as {
            spellCheckerDictionary?: { addWord(word: string): void };
          };
          wcSession.spellCheckerDictionary?.addWord(params.misspelledWord);
        }
      });

      template.push({ type: 'separator' });
    }

    // Look Up, Translate and Synonyms (macOS)
    if (process.platform === 'darwin' && params.selectionText) {
      template.push({
        label: `Look Up "${params.selectionText}"`,
        click: () => {
          mainWindow.webContents.showDefinitionForSelection();
        }
      });

      template.push({
        label: `Translate "${params.selectionText}"`,
        click: () => {
          mainWindow.webContents.send('translate:word', params.selectionText);
        }
      });

      template.push({ type: 'separator' });
    }

    if (params.selectionText) {
      // Synonyms submenu: dynamically load `thesaurus` and show up to 10 items.
      try {
        // Dynamically import `thesaurus` to avoid `require()` and keep startup fast.
        const mod = await import('thesaurus').catch((e) => {
          console.error('Failed to import thesaurus module:', e);
          return null;
        });
        type ThesaurusType = { find?: (word: string) => string[] } | ((word: string) => string[]);
        const thesaurus: ThesaurusType | null = mod
          ? ((mod as unknown as { default?: ThesaurusType }).default ??
            (mod as unknown as ThesaurusType))
          : null;
        let rawResults: string[] = [];
        if (thesaurus) {
          if (typeof (thesaurus as { find?: unknown }).find === 'function') {
            rawResults =
              (thesaurus as { find: (word: string) => string[] }).find(params.selectionText) || [];
          } else if (typeof thesaurus === 'function') {
            rawResults = (thesaurus as (word: string) => string[])(params.selectionText) || [];
          }
        }
        const results = Array.isArray(rawResults) ? rawResults.slice(0, 10) : [];

        const submenuItems: Electron.MenuItemConstructorOptions[] = results.map((syn) => ({
          label: syn,
          click: () => {
            // Replace the current selection in the page with the chosen synonym
            // Send a structured IPC event for the renderer to handle replacement
            mainWindow.webContents.send('menu:replace-selection', syn);
          }
        }));

        if (submenuItems.length === 0) {
          submenuItems.push({ label: 'No synonyms', enabled: false });
        }

        template.push({ label: 'Synonyms', submenu: submenuItems });
      } catch (err) {
        console.error('Failed to load thesaurus for synonyms menu:', err);
        template.push({ label: 'Synonyms', submenu: [{ label: 'Unavailable', enabled: false }] });
      }

      template.push({ type: 'separator' });
    }

    // Undo/Redo
    if (params.editFlags?.canUndo) {
      template.push({
        label: 'Undo',
        role: 'undo'
      });
    }
    if (params.editFlags?.canRedo) {
      template.push({
        label: 'Redo',
        role: 'redo'
      });
    }

    if ((params.editFlags?.canUndo || params.editFlags?.canRedo) && !params.misspelledWord) {
      template.push({ type: 'separator' });
    }

    // Cut/Copy/Paste
    template.push({
      label: 'Cut',
      role: 'cut'
    });
    template.push({
      label: 'Copy',
      role: 'copy'
    });
    template.push({
      label: 'Paste',
      role: 'paste'
    });

    template.push({ type: 'separator' });

    // Select All
    template.push({
      label: 'Select All',
      role: 'selectAll'
    });

    // Speech submenu (macOS)
    if (process.platform === 'darwin') {
      template.push({ type: 'separator' });
      template.push({
        label: 'Speech',
        submenu: [
          {
            label: 'Speak',
            click: () => {
              mainWindow.webContents.send('speech:speak', params.selectionText);
            }
          },
          {
            label: 'Stop Speaking',
            click: () => {
              mainWindow.webContents.send('speech:stop');
            }
          }
        ]
      });
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron');

  // Register custom phosphor:// protocol for asset serving
  setupProtocol();

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Ensure IPC handlers for settings are registered, then load settings
  setupSettingsHandlers();
  let settings: UserSettings | undefined;
  try {
    settings = await initializeSettings();
    console.log('Settings initialized');
  } catch (err) {
    console.error('Failed to initialize settings:', err);
  }

  const mainWindow = createWindow(settings);
  setupIPC(mainWindow);
  createMenu(mainWindow);

  // Persist window bounds on close so we can restore on next launch
  mainWindow.on('close', async () => {
    try {
      const b = mainWindow.getBounds();
      await updateSettings({ windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
    } catch (err) {
      console.error('Failed to save window bounds:', err);
    }
  });

  // Try to auto-open the last used vault if present
  try {
    const last = await getSavedVaultPath();
    console.log('Attempting to auto-open saved vault:', last);
    if (last) {
      // ensure path exists before opening
      try {
        await import('fs').then((fs) => fs.promises.access(last));
        console.log('Saved vault path exists; opening:', last);
        await openVaultPath(last, mainWindow);
        console.log('Auto-opened last vault:', last);
      } catch (err) {
        console.warn('Saved vault path not accessible:', last, err);
      }
    }
  } catch (err) {
    console.error('Failed to auto-open last vault', err);
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Handle before-quit to prompt user about unsaved changes
  let allowQuit = false; // Flag to prevent multiple quit attempts
  app.on('before-quit', (_event) => {
    if (allowQuit) return; // Already confirmed, allow quit

    // Ask renderer if there are unsaved changes
    mainWindow.webContents.send('app:check-unsaved-changes');
    _event.preventDefault(); // Prevent immediate quit

    // Listen for response with a timeout
    const timeout = setTimeout(() => {
      allowQuit = true;
      app.quit();
    }, 2000); // 2 second timeout before forcing quit

    // Will be set to false after user chooses action
    ipcMain.once('app:unsaved-changes-result', (_event, hasUnsaved: boolean) => {
      clearTimeout(timeout);
      if (hasUnsaved) {
        // Renderer will show a dialog, don't proceed
        console.debug('[App] Renderer has unsaved changes, not quitting');
      } else {
        // Safe to quit
        allowQuit = true;
        app.quit();
      }
    });
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

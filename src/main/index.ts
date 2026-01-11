import {
  app,
  shell,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  MenuItem,
  protocol,
  net
} from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { setupIPC, getSavedVaultPath, openVaultPath, getActiveVaultPath } from './ipc';
import { openVaultFromMenu } from './menuHelpers';

// Custom protocol for secure asset serving
function setupProtocol(): void {
  protocol.handle('phosphor', async (request) => {
    const vaultPath = getActiveVaultPath();
    if (!vaultPath) {
      return new Response('No vault active', { status: 404 });
    }

    // Strip the protocol and get the file path relative to vault
    const filePath = request.url.slice('phosphor://'.length);

    // Security: Ensure the path is within the vault and _assets folder
    const fullPath = join(vaultPath, '_assets', filePath);
    const normalized = join(fullPath);
    const vaultAssetsPath = join(vaultPath, '_assets');

    // Ensure the resolved path is within _assets
    if (!normalized.startsWith(vaultAssetsPath)) {
      return new Response('Access denied', { status: 403 });
    }

    try {
      return await net.fetch(new URL(`file://${normalized}`).href);
    } catch (err) {
      console.error('Failed to serve asset:', filePath, err);
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
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
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
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

  const mainWindow = createWindow();
  setupIPC(mainWindow);

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

  // Add menu item to open a different vault
  const template: (MenuItemConstructorOptions | MenuItem)[] = [];

  // App menu (macOS)
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  // File menu with our Open Vault action
  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Open Vault...',
        accelerator: 'CmdOrCtrl+O',
        click: () => {
          // use helper
          openVaultFromMenu(mainWindow).catch((e) => console.error(e));
        }
      },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
    ]
  });

  // Standard Edit, View, Window menus
  template.push({ role: 'editMenu' });
  template.push({ role: 'viewMenu' });
  template.push({ role: 'windowMenu' });

  // Help menu
  template.push({
    role: 'help',
    submenu: [
      {
        label: 'Learn More',
        click: async () => {
          await shell.openExternal('https://github.com/adcaudill/phosphor-notes');
        }
      }
    ]
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

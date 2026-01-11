import { app, shell, BrowserWindow, Menu } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { setupIPC, getSavedVaultPath, openVaultPath } from './ipc';

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
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
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { openVaultFromMenu } = await import('./menuHelpers');
            openVaultFromMenu(mainWindow);
          }
        },
        { role: 'quit' }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template as any);
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

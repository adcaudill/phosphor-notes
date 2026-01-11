import { app, Menu, BrowserWindow, shell } from 'electron';
import { openVaultFromMenu } from './menuHelpers';

export function createMenu(mainWindow: BrowserWindow | null): void {
  const template: Electron.MenuItemConstructorOptions[] = [];

  // App menu (macOS only)
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

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Note',
        accelerator: 'Cmd+N',
        click: () => {
          mainWindow?.webContents.send('menu:new-note');
        }
      },
      {
        label: 'Save',
        accelerator: 'Cmd+S',
        click: () => {
          mainWindow?.webContents.send('menu:save');
        }
      },
      { type: 'separator' },
      {
        label: 'Open Vault...',
        accelerator: 'Cmd+O',
        click: () => {
          if (mainWindow) {
            openVaultFromMenu(mainWindow).catch((e) => console.error(e));
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Search',
        accelerator: 'Cmd+K',
        click: () => {
          mainWindow?.webContents.send('menu:search');
        }
      },
      { type: 'separator' },
      {
        label: 'Close Window',
        accelerator: 'Cmd+W',
        role: 'close'
      },
      {
        label: 'Exit',
        accelerator: 'Cmd+Q',
        role: 'quit'
      }
    ]
  });

  // Standard Edit menu
  template.push({ role: 'editMenu' });

  template.push({
    label: 'View',
    submenu: [
      {
        label: 'Preferences',
        accelerator: 'Cmd+,',
        click: () => {
          mainWindow?.webContents.send('menu:preferences');
        }
      },
      { type: 'separator' },
      {
        label: 'Toggle Sidebar',
        accelerator: 'Cmd+\\',
        click: () => {
          mainWindow?.webContents.send('menu:toggle-sidebar');
        }
      },
      { type: 'separator' },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'Cmd+Option+I',
        role: 'toggleDevTools'
      }
    ]
  });

  // Standard Window menu
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
}

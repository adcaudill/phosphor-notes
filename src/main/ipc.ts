import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

// Store the active vault path in memory for this session
let activeVaultPath: string | null = null;

export function setupIPC(mainWindow: BrowserWindow) {

  // 1. Select Vault
  ipcMain.handle('vault:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Phosphor Vault',
      buttonLabel: 'Open Vault'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    activeVaultPath = result.filePaths[0];
    return path.basename(activeVaultPath); // Only return the folder name to UI
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
    } catch (err: any) {
      // If file doesn't exist, return empty string or create it
      if (err.code === 'ENOENT') {
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
}

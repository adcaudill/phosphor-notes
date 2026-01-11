import { BrowserWindow, dialog } from 'electron';
import { openVaultPath } from './ipc';

export async function openVaultFromMenu(mainWindow: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Phosphor Vault',
    buttonLabel: 'Open Vault'
  });

  if (result.canceled || result.filePaths.length === 0) return;
  const chosen = result.filePaths[0];
  await openVaultPath(chosen, mainWindow);
}

export default openVaultFromMenu;

import { contextBridge, ipcRenderer } from 'electron';

// Define the API implementation
const api = {
  selectVault: () => ipcRenderer.invoke('vault:select'),
  
  readNote: (filename: string) => ipcRenderer.invoke('note:read', filename),
  
  saveNote: (filename: string, content: string) => ipcRenderer.invoke('note:save', filename, content),

  listFiles: () => ipcRenderer.invoke('vault:list'),
  
  getDailyNoteFilename: () => {
    const today = new Date();
    // Format: YYYY-MM-DD.md
    const filename = today.toISOString().split('T')[0] + '.md';
    return Promise.resolve(filename);
  }
};

// Expose it to the main world (Renderer)
// We cast 'api' to ensure it matches the interface defined in d.ts implies, 
// though strict type checking here requires importing the interface.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('phosphor', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // Fallback for non-isolated contexts (should not happen in modern Electron)
  // @ts-ignore
  window.phosphor = api;
}

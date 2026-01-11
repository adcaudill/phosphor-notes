import { contextBridge, ipcRenderer } from 'electron';

// Define the API implementation
const api = {
  selectVault: () => ipcRenderer.invoke('vault:select'),
  getCurrentVault: () => ipcRenderer.invoke('vault:current'),

  readNote: (filename: string) => ipcRenderer.invoke('note:read', filename),

  saveNote: (filename: string, content: string) =>
    ipcRenderer.invoke('note:save', filename, content),

  saveAsset: (buffer: ArrayBuffer, originalName: string) =>
    ipcRenderer.invoke('asset:save', buffer, originalName),

  listFiles: () => ipcRenderer.invoke('vault:list'),

  // Event subscription for graph updates
  onGraphUpdate: (cb: (graph: Record<string, string[]>) => void) => {
    const handler = (_: any, data: Record<string, string[]>) => cb(data);
    ipcRenderer.on('phosphor:graph-update', handler);
    return () => ipcRenderer.removeListener('phosphor:graph-update', handler);
  },

  // Event subscription for status updates
  onStatusUpdate: (cb: (status: { type: string; message: string }) => void) => {
    const handler = (_: any, data: { type: string; message: string }) => cb(data);
    ipcRenderer.on('phosphor:status', handler);
    return () => ipcRenderer.removeListener('phosphor:status', handler);
  },

  // Event subscription for menu events
  onMenuEvent: (eventName: string, cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(eventName, handler);
    return () => ipcRenderer.removeListener(eventName, handler);
  },

  getDailyNoteFilename: () => {
    const today = new Date();
    // Format: YYYY-MM-DD.md
    const filename = today.toISOString().split('T')[0] + '.md';
    return Promise.resolve(filename);
  },
  // Load cached graph from the currently opened vault (if any)
  getCachedGraph: () => ipcRenderer.invoke('graph:load-cache'),
  // Get last graph in memory from main (if any)
  getLatestGraph: () => ipcRenderer.invoke('graph:get'),
  // Search vault
  search: (query: string) => ipcRenderer.invoke('vault:search', query)
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

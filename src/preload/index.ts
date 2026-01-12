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

  // Event subscription for vault file changes
  onFileChanged: (cb: (filename: string) => void) => {
    const handler = (_: any, filename: string) => cb(filename);
    ipcRenderer.on('vault:file-changed', handler);
    return () => ipcRenderer.removeListener('vault:file-changed', handler);
  },

  // Event subscription for vault file deletions
  onFileDeleted: (cb: (filename: string) => void) => {
    const handler = (_: any, filename: string) => cb(filename);
    ipcRenderer.on('vault:file-deleted', handler);
    return () => ipcRenderer.removeListener('vault:file-deleted', handler);
  },

  // Event subscription for vault file additions
  onFileAdded: (cb: (filename: string) => void) => {
    const handler = (_: any, filename: string) => cb(filename);
    ipcRenderer.on('vault:file-added', handler);
    return () => ipcRenderer.removeListener('vault:file-added', handler);
  },

  // Listen for app quit check and respond with unsaved status
  onCheckUnsavedChanges: (cb: (hasUnsaved: boolean) => void) => {
    const handler = () => {
      const hasUnsaved = cb(false); // Call the callback to determine if there are unsaved changes
      ipcRenderer.send('app:unsaved-changes-result', hasUnsaved);
    };
    ipcRenderer.on('app:check-unsaved-changes', handler);
    return () => ipcRenderer.removeListener('app:check-unsaved-changes', handler);
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
  search: (query: string) => ipcRenderer.invoke('vault:search', query),

  // Tasks API
  getTaskIndex: () => ipcRenderer.invoke('tasks:get'),
  onTasksUpdate: (cb: (tasks: any[]) => void) => {
    const handler = (_: any, data: any[]) => cb(data);
    ipcRenderer.on('phosphor:tasks-update', handler);
    return () => ipcRenderer.removeListener('phosphor:tasks-update', handler);
  },

  // Settings API
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
  setMultipleSettings: (updates: Record<string, any>) =>
    ipcRenderer.invoke('settings:set-multiple', updates),
  // Listen for settings changes from other windows
  onSettingsChange: (cb: (settings: any) => void) => {
    const handler = (_: any, data: any) => cb(data);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },

  // Encryption API
  isEncryptionEnabled: () => ipcRenderer.invoke('encryption:is-enabled'),
  unlockVault: (password: string) => ipcRenderer.invoke('encryption:unlock', password),
  lockVault: () => ipcRenderer.invoke('encryption:lock'),
  isVaultUnlocked: () => ipcRenderer.invoke('encryption:is-unlocked'),
  createEncryption: (password: string) => ipcRenderer.invoke('encryption:create', password),

  // Delete note
  deleteNote: (filename: string) => ipcRenderer.invoke('note:delete', filename)
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

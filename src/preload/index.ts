import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { Task, UserSettings } from '../types/phosphor';
import type { PredictionModelSnapshot } from '../shared/predictionModel';

const parsePredictionModel = (
  data: PredictionModelSnapshot | string | null
): PredictionModelSnapshot | null => {
  if (!data) return null;
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data) as PredictionModelSnapshot;
  } catch {
    return null;
  }
};

// Define the API implementation
const api = {
  selectVault: () => ipcRenderer.invoke('vault:select'),
  getCurrentVault: () => ipcRenderer.invoke('vault:current'),

  readNote: (filename: string) => ipcRenderer.invoke('note:read', filename),

  saveNote: (filename: string, content: string) =>
    ipcRenderer.invoke('note:save', filename, content),

  saveAsset: (buffer: ArrayBuffer, originalName: string) =>
    ipcRenderer.invoke('asset:save', buffer, originalName),

  openAsset: (filename: string) => ipcRenderer.invoke('asset:open', filename),

  listFiles: () => ipcRenderer.invoke('vault:list'),

  getMRUFiles: () => ipcRenderer.invoke('vault:mru'),

  updateMRU: (filename: string) => ipcRenderer.invoke('vault:update-mru', filename),

  // Favorites
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  toggleFavorite: (filename: string) => ipcRenderer.invoke('favorites:toggle', filename),
  onFavoritesChange: (cb: (favorites: string[]) => void) => {
    const handler = (_event: IpcRendererEvent, data: string[]): void => cb(data);
    ipcRenderer.on('phosphor:favorites-updated', handler);
    return () => ipcRenderer.removeListener('phosphor:favorites-updated', handler);
  },

  // Event subscription for graph updates
  onGraphUpdate: (cb: (graph: Record<string, string[]>) => void) => {
    const handler = (_event: IpcRendererEvent, data: Record<string, string[]>): void => cb(data);
    ipcRenderer.on('phosphor:graph-update', handler);
    return () => ipcRenderer.removeListener('phosphor:graph-update', handler);
  },

  onPredictionModel: (cb: (model: PredictionModelSnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, data: PredictionModelSnapshot | string): void => {
      const parsed = parsePredictionModel(data);
      if (parsed) cb(parsed);
    };
    ipcRenderer.on('phosphor:prediction-model', handler);
    return () => ipcRenderer.removeListener('phosphor:prediction-model', handler);
  },

  // Event subscription for status updates
  onStatusUpdate: (cb: (status: { type: string; message: string }) => void) => {
    const handler = (_event: IpcRendererEvent, data: { type: string; message: string }): void =>
      cb(data);
    ipcRenderer.on('phosphor:status', handler);
    return () => ipcRenderer.removeListener('phosphor:status', handler);
  },

  // Event subscription for import progress
  onImportProgress: (
    cb: (progress: { current: number; total: number; currentFile: string }) => void
  ) => {
    const handler = (
      _event: IpcRendererEvent,
      data: { current: number; total: number; currentFile: string }
    ): void => cb(data);
    ipcRenderer.on('phosphor:import-progress', handler);
    return () => ipcRenderer.removeListener('phosphor:import-progress', handler);
  },

  // Fired when main opens/switches vaults
  onVaultOpened: (cb: (vaultName: string) => void) => {
    const handler = (_event: IpcRendererEvent, data: string): void => cb(data);
    ipcRenderer.on('phosphor:vault-opened', handler);
    return () => ipcRenderer.removeListener('phosphor:vault-opened', handler);
  },

  // Event subscription for menu events
  onMenuEvent: (eventName: string, cb: (...args: unknown[]) => void) => {
    const handler = (_event: IpcRendererEvent, ...args: unknown[]): void => cb(...args);
    ipcRenderer.on(eventName, handler);
    return () => ipcRenderer.removeListener(eventName, handler);
  },

  // Event subscription for vault file changes
  onFileChanged: (cb: (filename: string) => void) => {
    const handler = (_event: IpcRendererEvent, filename: string): void => cb(filename);
    ipcRenderer.on('vault:file-changed', handler);
    return () => ipcRenderer.removeListener('vault:file-changed', handler);
  },

  // Event subscription for vault file deletions
  onFileDeleted: (cb: (filename: string) => void) => {
    const handler = (_event: IpcRendererEvent, filename: string): void => cb(filename);
    ipcRenderer.on('vault:file-deleted', handler);
    return () => ipcRenderer.removeListener('vault:file-deleted', handler);
  },

  // Event subscription for vault file additions
  onFileAdded: (cb: (filename: string) => void) => {
    const handler = (_event: IpcRendererEvent, filename: string): void => cb(filename);
    ipcRenderer.on('vault:file-added', handler);
    return () => ipcRenderer.removeListener('vault:file-added', handler);
  },

  // Listen for app quit check and respond with unsaved status
  onCheckUnsavedChanges: (cb: (hasUnsaved: boolean) => boolean) => {
    const handler = (): void => {
      const hasUnsaved = cb(false); // Call the callback to determine if there are unsaved changes
      ipcRenderer.send('app:unsaved-changes-result', hasUnsaved);
    };
    ipcRenderer.on('app:check-unsaved-changes', handler);
    return () => ipcRenderer.removeListener('app:check-unsaved-changes', handler);
  },

  getDailyNoteFilename: () => {
    const today = new Date();
    // Use local date components to avoid UTC-based rollovers
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const filename = `${year}-${month}-${day}.md`;
    return Promise.resolve(filename);
  },
  // Load cached graph from the currently opened vault (if any)
  getCachedGraph: () => ipcRenderer.invoke('graph:load-cache'),
  // Get last graph in memory from main (if any)
  getLatestGraph: () => ipcRenderer.invoke('graph:get'),
  // Get last prediction model snapshot (if any)
  getPredictionModel: async (): Promise<PredictionModelSnapshot | null> => {
    const data = (await ipcRenderer.invoke('prediction:get')) as
      | PredictionModelSnapshot
      | string
      | null;
    return parsePredictionModel(data);
  },
  // Search vault
  search: (query: string) => ipcRenderer.invoke('vault:search', query),

  // Update graph for a file (called when leaving a file to index its current state)
  updateGraphForFile: (filename: string) => ipcRenderer.invoke('graph:update-file', filename),

  // Update tasks for a file (called when leaving a file to index its current state)
  updateTasksForFile: (filename: string) => ipcRenderer.invoke('tasks:update-file', filename),

  // URL opening - opens URLs in the default browser
  openURL: (url: string) => ipcRenderer.invoke('url:open', url),

  // Tasks API
  getTaskIndex: () => ipcRenderer.invoke('tasks:get'),
  onTasksUpdate: (cb: (tasks: Task[]) => void) => {
    const handler = (_event: IpcRendererEvent, data: Task[]): void => cb(data);
    ipcRenderer.on('phosphor:tasks-update', handler);
    return () => {
      ipcRenderer.removeListener('phosphor:tasks-update', handler);
    };
  },

  // Settings API
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  setMultipleSettings: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:set-multiple', updates),
  // Listen for settings changes from other windows
  onSettingsChange: (cb: (settings: UserSettings) => void) => {
    const handler = (_event: IpcRendererEvent, data: UserSettings): void => cb(data);
    ipcRenderer.on('settings:changed', handler);
    return () => {
      ipcRenderer.removeListener('settings:changed', handler);
    };
  },

  // Encryption API
  isEncryptionEnabled: () => ipcRenderer.invoke('encryption:is-enabled'),
  unlockVault: (password: string) => ipcRenderer.invoke('encryption:unlock', password),
  lockVault: () => ipcRenderer.invoke('encryption:lock'),
  isVaultUnlocked: () => ipcRenderer.invoke('encryption:is-unlocked'),
  createEncryption: (password: string) => ipcRenderer.invoke('encryption:create', password),

  // Delete note
  deleteNote: (filename: string) => ipcRenderer.invoke('note:delete', filename),
  // Move note: opens a folder picker in main and moves the file within the vault
  moveNote: (filename: string) => ipcRenderer.invoke('note:move', filename),
  // Rename note: provide a new filename (may include path) within the vault
  renameNote: (oldFilename: string, newFilename: string) =>
    ipcRenderer.invoke('note:rename', oldFilename, newFilename),

  // Import Logseq vault
  importLogseq: () => ipcRenderer.invoke('import:logseq'),

  // Get app versions
  getVersions: () => ipcRenderer.invoke('app:get-versions'),

  // Trigger menu actions from UI
  triggerMenuAction: (action: string) => ipcRenderer.send('menu:trigger-action', action),

  // Speech API
  speak: (text: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  },
  stopSpeaking: () => {
    window.speechSynthesis.cancel();
  },
  isSpeaking: () => window.speechSynthesis.speaking
};

// Setup IPC listeners for speech commands from context menu
ipcRenderer.on('speech:speak', (_event, text: string) => {
  api.speak(text);
});

ipcRenderer.on('speech:stop', () => {
  api.stopSpeaking();
});

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
  window.phosphor = api;
}

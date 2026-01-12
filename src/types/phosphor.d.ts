// src/types/phosphor.d.ts

export interface Task {
  file: string;
  line: number;
  status: 'todo' | 'doing' | 'done';
  text: string;
  dueDate?: string; // ISO date string (YYYY-MM-DD)
  completedAt?: string; // ISO datetime string (YYYY-MM-DD HH:MM:SS)
}

export interface PhosphorAPI {
  // Vault Management
  selectVault: () => Promise<string | null>; // Returns the folder name (not full path) or null if cancelled
  getCurrentVault: () => Promise<string | null>;

  // File Operations
  readNote: (filename: string) => Promise<string>;
  saveNote: (filename: string, content: string) => Promise<boolean>;
  saveAsset: (buffer: ArrayBuffer, originalName: string) => Promise<string>; // Returns filename

  getDailyNoteFilename: () => Promise<string>; // Returns 'YYYY-MM-DD.md'
  getCachedGraph: () => Promise<Record<string, string[]> | null>;

  listFiles: () => Promise<string[]>;
  onGraphUpdate: (cb: (graph: Record<string, string[]>) => void) => () => void;
  onStatusUpdate: (cb: (status: { type: string; message: string }) => void) => () => void;
  onMenuEvent: (eventName: string, cb: () => void) => () => void;
  onFileChanged: (cb: (filename: string) => void) => () => void;
  onFileDeleted: (cb: (filename: string) => void) => () => void;
  onFileAdded: (cb: (filename: string) => void) => () => void;
  onCheckUnsavedChanges: (cb: (hasUnsaved: boolean) => boolean) => () => void;
  getLatestGraph: () => Promise<Record<string, string[]> | null>;
  search: (query: string) => Promise<Array<{ id: string; title: string; filename: string }>>;

  // Tasks
  getTaskIndex: () => Promise<Task[]>;
  onTasksUpdate: (cb: (tasks: Task[]) => void) => () => void;

  // Settings
  getSettings: () => Promise<UserSettings>;
  setSetting: (key: keyof UserSettings, value: any) => Promise<UserSettings>;
  setMultipleSettings: (updates: Partial<UserSettings>) => Promise<UserSettings>;
  onSettingsChange: (cb: (settings: UserSettings) => void) => () => void;
}

export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  colorPalette: 'snow' | 'amber' | 'green';
  editorFontSize: number;
  vimMode: boolean;
  showLineNumbers: boolean;
  lineHeight: number;
}

declare global {
  interface Window {
    phosphor: PhosphorAPI;
  }
}

interface SearchResult {
  id: string;
  title: string;
  filename: string;
}

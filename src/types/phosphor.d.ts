// src/types/phosphor.d.ts

export interface PhosphorAPI {
  // Vault Management
  selectVault: () => Promise<string | null>; // Returns the folder name (not full path) or null if cancelled
  getCurrentVault: () => Promise<string | null>;

  // File Operations
  readNote: (filename: string) => Promise<string>;
  saveNote: (filename: string, content: string) => Promise<boolean>;

  getDailyNoteFilename: () => Promise<string>; // Returns 'YYYY-MM-DD.md'
  getCachedGraph: () => Promise<Record<string, string[]> | null>;

  listFiles: () => Promise<string[]>;
  onGraphUpdate: (cb: (graph: Record<string, string[]>) => void) => () => void;
  onStatusUpdate: (cb: (status: { type: string; message: string }) => void) => () => void;
  getLatestGraph: () => Promise<Record<string, string[]> | null>;
  search: (query: string) => Promise<Array<{ id: string; title: string; filename: string }>>;
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

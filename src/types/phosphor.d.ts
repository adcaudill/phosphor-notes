// src/types/phosphor.d.ts

export interface PhosphorAPI {
  // Vault Management
  selectVault: () => Promise<string | null>; // Returns the folder name (not full path) or null if cancelled
  
  // File Operations
  readNote: (filename: string) => Promise<string>;
  saveNote: (filename: string, content: string) => Promise<boolean>;
  
  // Day 1: Daily Journal Helper
  getDailyNoteFilename: () => Promise<string>; // Returns 'YYYY-MM-DD.md'
}

declare global {
  interface Window {
    phosphor: PhosphorAPI;
  }
}

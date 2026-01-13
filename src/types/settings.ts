// Shared types between main and renderer
export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  editorFontSize: number;
  vimMode: boolean;
  showLineNumbers: boolean;
  lineHeight: number;
  defaultJournalMode: 'freeform' | 'outliner';
}

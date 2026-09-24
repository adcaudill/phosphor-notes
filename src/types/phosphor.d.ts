// src/types/phosphor.d.ts

import type { PredictionModelSnapshot } from '../shared/predictionModel';

export type { Task, Priority, Recurrence, RecurrenceUnit, Status as TaskStatus } from '../shared/tasks';

export interface McpStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  /** Non-null only when the last attempt to start listening failed, e.g. "PORT_IN_USE". */
  error: string | null;
  hasToken: boolean;
  tokenCreatedAt: string | null;
  vaultReadable: boolean;
  /** A second, separate opt-in from `enabled` - true only when both the server and write access are on. */
  writeEnabled: boolean;
}

export interface McpActivityEntry {
  ts: string; // ISO timestamp
  tool: string;
  ok: boolean;
  errorCode?: string;
  /** The vault-relative path affected, for write-tool calls only. */
  target?: string;
  /** True for a create/append/add-task style call, so the UI can badge it distinctly from a read. */
  write?: boolean;
}

export interface McpClientConfig {
  url: string;
  /** A ready-to-run `claude mcp add ...` command for Claude Code. */
  claudeCode: string;
  /** A config snippet for stdio-only clients (e.g. Claude Desktop), bridged via the community `mcp-remote` tool. */
  mcpRemote: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

export interface PhosphorAPI {
  // Vault Management
  selectVault: () => Promise<string | null>; // Returns the folder name (not full path) or null if cancelled
  getCurrentVault: () => Promise<string | null>;

  // File Operations
  readNote: (filename: string) => Promise<string>;
  saveNote: (filename: string, content: string) => Promise<boolean>;
  saveAsset: (buffer: ArrayBuffer, originalName: string) => Promise<string>; // Returns filename
  openAsset: (filename: string) => Promise<boolean>;

  getDailyNoteFilename: () => Promise<string>; // Returns 'YYYY-MM-DD.md'
  getCachedGraph: () => Promise<Record<string, string[]> | null>;
  getPredictionModel: () => Promise<PredictionModelSnapshot | null>;
  getGraphStats: () => Promise<{
    totalFiles: number;
    totalLinks: number;
    avgLinksPerFile: number;
    isolatedFiles: number;
    cycles: number;
    mostLinked: { file: string; backlinks: number }[];
  }>;

  listFiles: () => Promise<string[]>;
  getMRUFiles: () => Promise<string[]>;
  getFavorites: () => Promise<string[]>;
  updateMRU: (filename: string) => Promise<string[]>;
  toggleFavorite: (filename: string) => Promise<string[]>;
  onFavoritesChange: (cb: (favorites: string[]) => void) => () => void;
  onGraphUpdate: (cb: (graph: Record<string, string[]>) => void) => () => void;
  onPredictionModel: (cb: (model: PredictionModelSnapshot) => void) => () => void;
  onStatusUpdate: (cb: (status: { type: string; message: string }) => void) => () => void;
  onMenuEvent: (eventName: string, cb: (...args: unknown[]) => void) => () => void;
  onFileChanged: (cb: (filename: string) => void) => () => void;
  onFileDeleted: (cb: (filename: string) => void) => () => void;
  onFileAdded: (cb: (filename: string) => void) => () => void;
  onCheckUnsavedChanges: (cb: (hasUnsaved: boolean) => boolean) => () => void;
  getLatestGraph: () => Promise<Record<string, string[]> | null>;
  search: (
    query: string
  ) => Promise<Array<{ id: string; title: string; filename: string; snippet?: string }>>;
  updateGraphForFile: (filename: string) => Promise<void>;
  updateTasksForFile: (filename: string) => Promise<void>;
  deleteNote: (filename: string) => Promise<boolean>;
  openURL: (url: string) => Promise<void>;

  // Encryption
  isEncryptionEnabled: () => Promise<boolean>;
  unlockVault: (password: string) => Promise<boolean>; // Returns true if unlock successful
  lockVault: () => Promise<void>; // Clears the master key from memory
  isVaultUnlocked: () => Promise<boolean>;
  createEncryption: (password: string) => Promise<boolean>; // Create encryption for vault

  // Import
  importLogseq: () => Promise<{ success: boolean; error?: string; filesImported?: number }>;
  onImportProgress: (
    cb: (progress: { current: number; total: number; currentFile: string }) => void
  ) => () => void;
  // Fired when main opens or switches vaults. Provides the vault folder name.
  onVaultOpened: (cb: (vaultName: string) => void) => () => void;

  // Tasks
  getTaskIndex: () => Promise<Task[]>;
  onTasksUpdate: (cb: (tasks: Task[]) => void) => () => void;
  /** Fast-path: the last full reindex's tasks, read straight from the on-disk `.phosphor/tasks.json` cache (like `getCachedGraph`). Null if no cache exists yet. */
  getCachedTasks: () => Promise<Task[] | null>;
  /**
   * Replaces one task line in place, verifying its current raw text first
   * (optimistic concurrency - throws if the line has since changed) and
   * updating the task index afterward. Used by inline metadata quick-edit
   * (e.g. the Tasks view) for files other than the one currently open in
   * the editor.
   */
  updateTaskLine: (
    filename: string,
    line: number,
    expectedText: string,
    newLines: string[]
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  // Settings
  getSettings: () => Promise<UserSettings>;
  setSetting: <K extends keyof UserSettings>(
    key: K,
    value: UserSettings[K]
  ) => Promise<UserSettings>;
  setMultipleSettings: (updates: Partial<UserSettings>) => Promise<UserSettings>;
  onSettingsChange: (cb: (settings: UserSettings) => void) => () => void;

  // MCP (Model Context Protocol) local server
  mcpGetStatus: () => Promise<McpStatus>;
  mcpSetEnabled: (enabled: boolean) => Promise<McpStatus>;
  /** Refused (status unchanged) if the server itself is disabled - enable it first. */
  mcpSetWriteEnabled: (enabled: boolean) => Promise<McpStatus>;
  mcpSetPort: (port: number) => Promise<McpStatus>;
  /** Generates a new token and returns the plaintext ONCE - only its hash is persisted. */
  mcpRegenerateToken: () => Promise<string>;
  mcpGetActivity: () => Promise<McpActivityEntry[]>;
  mcpGetClientConfig: (token: string) => Promise<McpClientConfig>;
  onMcpStatusChange: (cb: (status: McpStatus) => void) => () => void;

  // App Info
  getVersions: () => Promise<{ electron?: string; chrome?: string; node?: string; app?: string }>;

  // Menu actions
  triggerMenuAction: (action: string) => void;

  // Speech
  speak: (text: string) => void;
  stopSpeaking: () => void;
  isSpeaking: () => boolean;
}

export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  colorPalette: 'snow' | 'amber' | 'green';
  editorFontSize: number;
  vimMode: boolean;
  showLineNumbers: boolean;
  lineHeight: number;
  defaultJournalMode: 'freeform' | 'outliner';
  enableTypewriterScrolling: boolean;
  enableParagraphDimming: boolean;
  enableSmartTypography: boolean;
  // Grammar & Style settings
  checkPassiveVoice: boolean;
  checkSimplification: boolean;
  checkInclusiveLanguage: boolean;
  checkReadability: boolean;
  checkProfanities: boolean;
  checkCliches: boolean;
  checkIntensify: boolean;
  // Holiday settings
  holidayCountry: string;
  // Optional persisted window bounds from the last session
  windowBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  // Persist last-used task view filters
  lastTasksStatusFilter?: 'all' | 'todo' | 'doing' | 'done';
  lastTasksDateFilter?: 'all' | 'overdue' | 'today' | 'upcoming' | 'no-date';
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

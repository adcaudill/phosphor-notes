import { ipcMain } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { UserSettings } from '../types/phosphor.d';

const defaults: UserSettings = {
  theme: 'system',
  colorPalette: 'snow',
  editorFontSize: 16,
  vimMode: false,
  showLineNumbers: false,
  lineHeight: 1.5,
  defaultJournalMode: 'freeform',
  enableTypewriterScrolling: true,
  enableParagraphDimming: false,
  checkPassiveVoice: false,
  checkSimplification: false,
  checkInclusiveLanguage: false,
  checkReadability: false,
  checkProfanities: false,
  checkCliches: false,
  checkIntensify: false
};

const CONFIG_DIR = path.join(app.getPath('userData'), '.phosphor');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

let cachedSettings: UserSettings | null = null;

async function ensureConfigDir(): Promise<void> {
  try {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create config dir', err);
  }
}

async function loadSettings(): Promise<UserSettings> {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf-8');
    const loaded = JSON.parse(raw) as Partial<UserSettings>;
    // Merge with defaults to handle new fields in future versions
    return { ...defaults, ...loaded };
  } catch {
    // File doesn't exist or is corrupted, use defaults
    return defaults;
  }
}

async function saveSettings(settings: UserSettings): Promise<void> {
  try {
    await ensureConfigDir();
    await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    cachedSettings = settings;
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// Initialize settings on app start
export async function initializeSettings(): Promise<UserSettings> {
  if (cachedSettings) return cachedSettings;
  cachedSettings = await loadSettings();
  return cachedSettings;
}

// Set up IPC handlers for settings
export function setupSettingsHandlers(): void {
  ipcMain.handle('settings:get', async () => {
    if (!cachedSettings) {
      cachedSettings = await loadSettings();
    }
    return cachedSettings;
  });

  ipcMain.handle('settings:set', async (_, key: keyof UserSettings, value: unknown) => {
    if (!cachedSettings) {
      cachedSettings = await loadSettings();
    }
    // Type assertion necessary for dynamic property assignment
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settings = cachedSettings as Record<string, any>;
    settings[key as string] = value;
    await saveSettings(cachedSettings);
    return cachedSettings;
  });

  ipcMain.handle('settings:set-multiple', async (_, updates: Partial<UserSettings>) => {
    if (!cachedSettings) {
      cachedSettings = await loadSettings();
    }
    cachedSettings = { ...cachedSettings, ...updates };
    await saveSettings(cachedSettings);
    return cachedSettings;
  });
}

export function getDefaultSettings(): UserSettings {
  return defaults;
}

// Update settings programmatically from main process
export async function updateSettings(updates: Partial<UserSettings>): Promise<UserSettings> {
  if (!cachedSettings) {
    cachedSettings = await loadSettings();
  }
  cachedSettings = { ...cachedSettings, ...updates };
  await saveSettings(cachedSettings);
  return cachedSettings;
}

// MRU (Most Recently Used) list management
// Stored in vault's .phosphor/mru.json with up to 10 entries
interface MRUData {
  files: string[];
}

function getMRUPath(vaultPath: string): string {
  return path.join(vaultPath, '.phosphor', 'mru.json');
}

async function ensureMRUDir(vaultPath: string): Promise<void> {
  try {
    await fsp.mkdir(path.join(vaultPath, '.phosphor'), { recursive: true });
  } catch (err) {
    console.error('Failed to create .phosphor directory', err);
  }
}

async function loadMRU(vaultPath: string): Promise<MRUData> {
  try {
    const mruPath = getMRUPath(vaultPath);
    const raw = await fsp.readFile(mruPath, 'utf-8');
    return JSON.parse(raw) as MRUData;
  } catch {
    // File doesn't exist or is corrupted, return empty list
    return { files: [] };
  }
}

async function saveMRU(vaultPath: string, mruData: MRUData): Promise<void> {
  try {
    await ensureMRUDir(vaultPath);
    const mruPath = getMRUPath(vaultPath);
    await fsp.writeFile(mruPath, JSON.stringify(mruData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save MRU:', err);
  }
}

export async function initializeMRU(vaultPath: string): Promise<void> {
  // Initialize MRU file structure for the vault if it doesn't exist
  // (actual loading happens on-demand in getMRUFiles)
  const mruData = await loadMRU(vaultPath);
  if (mruData.files.length === 0) {
    // Create empty MRU file
    await saveMRU(vaultPath, { files: [] });
  }
}

export async function getMRUFiles(vaultPath: string): Promise<string[]> {
  const mruData = await loadMRU(vaultPath);
  return mruData.files;
}

export async function updateMRU(vaultPath: string, filename: string): Promise<string[]> {
  const mruData = await loadMRU(vaultPath);

  // Remove if already in list
  const index = mruData.files.indexOf(filename);
  if (index > -1) {
    mruData.files.splice(index, 1);
  }

  // Add to front
  mruData.files.unshift(filename);

  // Keep only 10 most recent
  if (mruData.files.length > 10) {
    mruData.files = mruData.files.slice(0, 10);
  }

  await saveMRU(vaultPath, mruData);
  return mruData.files;
}

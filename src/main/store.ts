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
  enableTypewriterScrolling: true,
  enableParagraphDimming: false
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

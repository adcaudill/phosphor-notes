import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';

// Create temp dir synchronously so we can mock 'electron' before importing the module
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-store-test-'));

// Top-level mock so module initialization in src/main/store.ts uses our tmpDir
vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        // store handler for test invocation
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        global.__ipcHandlers = global.__ipcHandlers || {};
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        global.__ipcHandlers[channel] = handler;
      }
    },
    app: {
      getPath: () => tmpDir
    }
  };
});

// Helper to centralize fs/promises mocks before importing modules
function mockFs({
  readFile,
  writeFile,
  mkdir
}: { readFile?: any; writeFile?: any; mkdir?: any } = {}) {
  const rf = readFile ?? vi.fn().mockRejectedValue(new Error('ENOENT'));
  const wf = writeFile ?? vi.fn();
  const md = mkdir ?? vi.fn();
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  vi.doMock('fs/promises', () => ({
    readFile: rf,
    writeFile: wf,
    mkdir: md
  }));
  return { readFile: rf, writeFile: wf, mkdir: md };
}

beforeEach(async () => {
  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  global.__ipcHandlers = {};
});

afterEach(async () => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  delete global.__ipcHandlers;
});

afterAll(async () => {
  // cleanup temp dir once tests finish
  try {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('store settings persistence and IPC handlers', () => {
  it('returns defaults when no settings file exists', async () => {
    const store = await import('../store');
    // initialize should read defaults when no file
    const settings = await store.initializeSettings();
    const defaults = store.getDefaultSettings();
    expect(settings).toEqual(defaults);
  });

  it('registers IPC handlers and persists changes', async () => {
    const store = await import('../store');

    // Set up handlers which will populate global.__ipcHandlers
    store.setupSettingsHandlers();

    // Call the 'settings:get' handler (should return defaults initially)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const getHandler = global.__ipcHandlers['settings:get'];
    const current = await getHandler();
    expect(current).toEqual(store.getDefaultSettings());

    // Call 'settings:set' handler to change a single key
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const setHandler = global.__ipcHandlers['settings:set'];
    const updated = await setHandler(null, 'theme', 'dark');
    expect(updated.theme).toBe('dark');

    // Verify file was written to disk
    const configPath = path.join(tmpDir, '.phosphor', 'settings.json');
    const raw = await fs.promises.readFile(configPath, 'utf-8');
    const disk = JSON.parse(raw);
    expect(disk.theme).toBe('dark');

    // Call 'settings:set-multiple' to update several keys
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const setMultiple = global.__ipcHandlers['settings:set-multiple'];
    const multi = await setMultiple(null, { editorFontSize: 20, vimMode: true });
    expect(multi.editorFontSize).toBe(20);
    expect(multi.vimMode).toBe(true);
  });

  it('loads settings from disk when settings file exists and merges with defaults', async () => {
    // Mock fs/promises to return a settings file
    vi.resetModules();
    const readMock = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ theme: 'dark', editorFontSize: 12 }));
    mockFs({ readFile: readMock, writeFile: vi.fn(), mkdir: vi.fn() });

    const store = await import('../store');
    const settings = await store.initializeSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.editorFontSize).toBe(12);
    // default value still present
    expect(settings.colorPalette).toBe(store.getDefaultSettings().colorPalette);
  });

  it('handles write failures in saveSettings (logs error) when settings:set is called', async () => {
    vi.resetModules();

    const writeMock = vi.fn().mockRejectedValue(new Error('disk full'));
    const readMock = vi.fn().mockRejectedValue(new Error('ENOENT'));

    mockFs({ readFile: readMock, writeFile: writeMock, mkdir: vi.fn() });

    // capture console.error
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = await import('../store');
    store.setupSettingsHandlers();

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const setHandler = global.__ipcHandlers['settings:set'];
    const result = await setHandler(null, 'theme', 'blue');

    // even if write failed, handler should return cached settings object (theme updated in-memory)
    expect(result.theme).toBe('blue');
    expect(writeMock).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('logs error when mkdir fails in ensureConfigDir during saveSettings', async () => {
    vi.resetModules();

    const mkdirMock = vi.fn().mockRejectedValue(new Error('mkdir fail'));
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const readMock = vi.fn().mockRejectedValue(new Error('ENOENT'));

    mockFs({ readFile: readMock, writeFile: writeMock, mkdir: mkdirMock });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = await import('../store');
    store.setupSettingsHandlers();

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const setHandler = global.__ipcHandlers['settings:set'];
    await setHandler(null, 'theme', 'x');

    expect(mkdirMock).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('calls loadSettings when cachedSettings is null for settings:set-multiple', async () => {
    vi.resetModules();

    const readMock = vi.fn().mockResolvedValue(JSON.stringify({ theme: 'dark' }));
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const mkdirMock = vi.fn().mockResolvedValue(undefined);

    mockFs({ readFile: readMock, writeFile: writeMock, mkdir: mkdirMock });

    const store = await import('../store');
    store.setupSettingsHandlers();

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const setMultiple = global.__ipcHandlers['settings:set-multiple'];
    const res = await setMultiple(null, { editorFontSize: 30 });

    expect(readMock).toHaveBeenCalled();
    expect(res.theme).toBe('dark');
    expect(res.editorFontSize).toBe(30);
  });

  it('initializeSettings caches the loaded settings and returns cached on subsequent calls', async () => {
    vi.resetModules();

    const readMock = vi.fn().mockRejectedValue(new Error('ENOENT'));
    mockFs({ readFile: readMock, writeFile: vi.fn(), mkdir: vi.fn() });

    const store = await import('../store');
    const first = await store.initializeSettings();
    expect(readMock).toHaveBeenCalled();
    const second = await store.initializeSettings();
    // second call should return cached object without calling read again
    expect(second).toBe(first);
  });

  it('settings:get handler loads settings when cachedSettings is null', async () => {
    vi.resetModules();

    const readMock = vi.fn().mockResolvedValue(JSON.stringify({ theme: 'pink' }));
    mockFs({ readFile: readMock, writeFile: vi.fn(), mkdir: vi.fn() });

    const store = await import('../store');
    store.setupSettingsHandlers();

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const getHandler = global.__ipcHandlers['settings:get'];
    const result = await getHandler();
    expect(readMock).toHaveBeenCalled();
    expect(result.theme).toBe('pink');
  });

  it('settings:get returns cached settings when cachedSettings is present', async () => {
    vi.resetModules();

    const readMock = vi.fn().mockResolvedValue(JSON.stringify({ theme: 'green' }));
    mockFs({ readFile: readMock, writeFile: vi.fn(), mkdir: vi.fn() });

    const store = await import('../store');
    // initialize to populate cachedSettings
    await store.initializeSettings();
    store.setupSettingsHandlers();

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const getHandler = global.__ipcHandlers['settings:get'];
    const r = await getHandler();
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(r.theme).toBe('green');
  });
});

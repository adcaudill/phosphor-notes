import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

describe('preload API', () => {
  let origContextIsolated: boolean | undefined;

  beforeEach(() => {
    vi.resetModules();
    origContextIsolated = (process as unknown as { contextIsolated?: boolean }).contextIsolated;
  });

  afterEach(() => {
    // restore process.contextIsolated to original value
    // @ts-ignore Restore original value
    process.contextIsolated = origContextIsolated;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exposes api via contextBridge when contextIsolated is true', async () => {
    const ipcInvoke = vi.fn().mockResolvedValue('ok');
    const ipcOn = vi.fn();
    const ipcRemove = vi.fn();

    const exposed: Record<string, unknown> = {};

    const contextBridge = {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed[key] = api;
      }
    };

    vi.doMock('electron', () => ({
      contextBridge,
      ipcRenderer: { invoke: ipcInvoke, on: ipcOn, removeListener: ipcRemove }
    }));

    // set contextIsolated true before import
    // @ts-ignore Restore original value
    process.contextIsolated = true;

    await import('../../preload/index');

    // typed API to avoid using `any`
    type PhosphorAPI = {
      selectVault: () => Promise<unknown>;
      getCurrentVault: () => Promise<unknown>;
    };

    expect(
      (exposed as Record<string, unknown> & { phosphor?: PhosphorAPI }).phosphor
    ).toBeDefined();
    const api = (exposed as Record<string, unknown> & { phosphor?: PhosphorAPI })
      .phosphor as PhosphorAPI;

    // call a couple of methods and ensure ipcRenderer.invoke gets called
    await api.selectVault();
    await api.getCurrentVault();

    expect(ipcInvoke).toHaveBeenCalled();
  });

  it('attaches api to window when not contextIsolated', async () => {
    const ipcInvoke = vi.fn().mockResolvedValue('ok');
    const ipcOn = vi.fn();
    const ipcRemove = vi.fn();

    vi.doMock('electron', () => ({
      ipcRenderer: { invoke: ipcInvoke, on: ipcOn, removeListener: ipcRemove }
    }));

    // simulate non-isolated context
    // @ts-ignore Restore original value
    process.contextIsolated = false;

    // ensure global window exists for the module to attach to; use vi.stubGlobal so it's auto-restored
    vi.stubGlobal('window', {} as unknown as Window);

    await import('../../preload/index');

    type PhosphorWindow = Window & {
      phosphor?: {
        getDailyNoteFilename: () => Promise<string>;
      };
    };
    const api = (globalThis as unknown as { window: PhosphorWindow }).window.phosphor;
    expect(api).toBeDefined();

    // call a simple method
    const filename = await api!.getDailyNoteFilename();
    expect(typeof filename).toBe('string');
  });
});

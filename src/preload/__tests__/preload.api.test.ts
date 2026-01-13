import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

describe('preload API', () => {
  let origContextIsolated: any;

  beforeEach(() => {
    vi.resetModules();
    origContextIsolated = (process as any).contextIsolated;
  });

  afterEach(() => {
    // restore process.contextIsolated to original value
    // @ts-ignore
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
    // @ts-ignore
    process.contextIsolated = true;

    await import('../../preload/index');

    expect((exposed as any).phosphor).toBeDefined();
    const api = (exposed as any).phosphor as any;

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
    // @ts-ignore
    process.contextIsolated = false;

    // ensure global window exists for the module to attach to; use vi.stubGlobal so it's auto-restored
    vi.stubGlobal('window', {} as any);

    await import('../../preload/index');

    const api = (global as any).window.phosphor as any;
    expect(api).toBeDefined();

    // call a simple method
    const filename = await api.getDailyNoteFilename();
    expect(typeof filename).toBe('string');
  });
});

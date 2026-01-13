import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

describe('watcher', () => {
  let mockWatcher: any;
  let chokidarWatchMock: any;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();

    // Create a mock watcher object where test can trigger events
    mockWatcher = {
      handlers: {} as Record<string, Function>,
      on(event: string, cb: Function) {
        this.handlers[event] = cb;
      },
      close: vi.fn()
    };

    chokidarWatchMock = vi.fn().mockImplementation(() => mockWatcher);
    vi.doMock('chokidar', () => ({
      default: { watch: chokidarWatchMock },
      watch: chokidarWatchMock
    }));
  });

  afterEach(() => {
    try {
      vi.useRealTimers();
    } catch {}
  });

  it('sends vault:file-changed and calls callback on change (debounced)', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const { setupWatcher, stopWatcher } = await import('../watcher');

    const onFileChange = vi.fn();
    const vaultPath = '/tmp/vault';

    setupWatcher(vaultPath, mainWindow, onFileChange);

    // Trigger change event
    mockWatcher.handlers['change'](path.join(vaultPath, 'note.md'));

    // Advance timers by debounce interval (300ms)
    vi.advanceTimersByTime(400);

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('vault:file-changed', 'note.md');
    expect(onFileChange).toHaveBeenCalledWith('note.md');

    stopWatcher();
  });

  it('does not send vault:file-changed for internal saves but still calls callback', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const { setupWatcher, markInternalSave, stopWatcher } = await import('../watcher');

    const onFileChange = vi.fn();
    const vaultPath = '/tmp/vault';

    setupWatcher(vaultPath, mainWindow, onFileChange);

    // Mark internal save and immediately trigger change
    markInternalSave();
    mockWatcher.handlers['change'](path.join(vaultPath, 'note2.md'));

    // callback should be called synchronously and send should NOT be called
    expect(onFileChange).toHaveBeenCalledWith('note2.md');
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();

    stopWatcher();
  });

  it('sends file-added and file-deleted events', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const { setupWatcher, stopWatcher } = await import('../watcher');

    const vaultPath = '/tmp/vault';
    setupWatcher(vaultPath, mainWindow);

    mockWatcher.handlers['add'](path.join(vaultPath, 'new.md'));
    mockWatcher.handlers['unlink'](path.join(vaultPath, 'gone.md'));

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('vault:file-added', 'new.md');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('vault:file-deleted', 'gone.md');

    stopWatcher();
  });

  it('does not send events when window is destroyed', async () => {
    const mainWindow = { isDestroyed: () => true, webContents: { send: vi.fn() } } as any;

    const { setupWatcher } = await import('../watcher');

    const onFileChange = vi.fn();
    const vaultPath = '/tmp/vault';
    setupWatcher(vaultPath, mainWindow, onFileChange);

    // Change event should still call callback but not send
    mockWatcher.handlers['change'](path.join(vaultPath, 'note.md'));
    vi.advanceTimersByTime(400);
    expect(onFileChange).toHaveBeenCalledWith('note.md');
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();

    // Add/unlink should not send
    mockWatcher.handlers['add'](path.join(vaultPath, 'added.md'));
    mockWatcher.handlers['unlink'](path.join(vaultPath, 'removed.md'));
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('debounces rapid change events into a single callback', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;
    const { setupWatcher, stopWatcher } = await import('../watcher');

    const onFileChange = vi.fn();
    const vaultPath = '/tmp/vault';
    setupWatcher(vaultPath, mainWindow, onFileChange);

    // Trigger change twice quickly
    mockWatcher.handlers['change'](path.join(vaultPath, 'note.md'));
    mockWatcher.handlers['change'](path.join(vaultPath, 'note.md'));

    // Advance time beyond debounce
    vi.advanceTimersByTime(400);

    expect(onFileChange).toHaveBeenCalledTimes(1);
    expect(onFileChange).toHaveBeenCalledWith('note.md');

    stopWatcher();
  });

  it('handles watcher error by logging', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;
    const { setupWatcher, stopWatcher } = await import('../watcher');

    const vaultPath = '/tmp/vault';
    setupWatcher(vaultPath, mainWindow);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWatcher.handlers['error'](new Error('boom'));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    stopWatcher();
  });

  it('stopWatcher is idempotent', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;
    const { setupWatcher, stopWatcher } = await import('../watcher');

    setupWatcher('/tmp/vault', mainWindow);
    stopWatcher();
    // second call should not throw
    stopWatcher();
  });
});

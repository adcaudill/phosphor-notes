import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

describe('coverage edgecases', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    try {
      vi.restoreAllMocks();
    } catch {
      // ignore errors restoring mocks during teardown
      void 0;
    }
  });

  it('crypto.decryptBuffer throws for invalid header', async () => {
    const { decryptBuffer } = await import('../crypto');

    // Pass a short random buffer that does not contain the magic header
    const bad = Buffer.from('NOTPHOS');

    expect(() => decryptBuffer(bad, Buffer.alloc(32))).toThrow(/Invalid file format|unencrypted/);
  });

  it('watcher handles console.debug throwing during internal save', async () => {
    // This targets the internal-save path where safeDebug is called inside a try/catch
    const path = await import('path');

    // Create a mock watcher like other watcher tests do
    const mockWatcher = {
      handlers: {} as Record<string, (...args: unknown[]) => void>,
      on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = cb;
      },
      close: vi.fn()
    };

    const chokidarWatchMock = vi.fn().mockImplementation(() => mockWatcher);
    vi.doMock('chokidar', () => ({
      default: { watch: chokidarWatchMock },
      watch: chokidarWatchMock
    }));

    // Make console.debug throw to exercise the catch branch in safeDebug usage
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('boom-debug');
    });

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { setupWatcher, markInternalSave, stopWatcher } = await import('../watcher');

    const onFileChange = vi.fn();
    const vaultPath = '/tmp/vault';

    setupWatcher(vaultPath, mainWindow, onFileChange);

    // Mark internal save and trigger change; safeDebug will throw but should be caught
    markInternalSave();
    mockWatcher.handlers['change'](path.join(vaultPath, 'note-debug.md'));

    // Callback still invoked and send NOT called
    expect(onFileChange).toHaveBeenCalledWith('note-debug.md');
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();

    stopWatcher();
    debugSpy.mockRestore();
  });
});

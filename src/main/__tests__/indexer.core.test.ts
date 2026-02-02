import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

// We'll dynamically import the module under test after setting up mocks

declare global {
  // test helper global used by fake Worker implementations
  var __LAST_FAKE_WORKER__:
    | {
        handlers?: Record<string, Array<(msg: unknown) => void>>;
        posted?: Array<Record<string, unknown>>;
        terminated?: boolean;
        emitMessage?: (msg: unknown) => void;
      }
    | undefined;
}

export {};

describe('indexer core helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear any global holder we use for the fake worker
    // @ts-ignore Clearing global
    delete global.__LAST_FAKE_WORKER__;
  });

  it('startIndexing should send decrypted content when encryption enabled', async () => {
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));

    // Fake Worker implementation
    class FakeWorker {
      handlers: Record<string, Array<(msg: unknown) => void>> = {} as Record<
        string,
        Array<(msg: unknown) => void>
      >;
      posted: Array<Record<string, unknown>> = [];
      terminated = false;
      constructor(_arg: unknown, _opts?: unknown) {
        void _arg;
        void _opts;
        // register globally so tests can access
        // @ts-ignore Clearing global
        global.__LAST_FAKE_WORKER__ = this;
      }
      on(evt: string, cb: (msg: unknown) => void): void {
        (this.handlers[evt] ||= []).push(cb);
      }
      postMessage(msg: unknown): void {
        this.posted = msg as Array<Record<string, unknown>>;
      }
      terminate(): void {
        this.terminated = true;
      }
      // helper to simulate incoming message
      emitMessage(msg: unknown): void {
        (this.handlers['message'] || []).forEach((cb: (msg: unknown) => void) => cb(msg));
      }
    }

    // Mock worker_threads
    vi.doMock('worker_threads', () => ({ Worker: FakeWorker }));

    // Mock fs and promises
    const existsSync = vi.fn().mockReturnValue(true);
    const fspMock: Partial<typeof import('fs').promises> = {
      readdir: vi.fn().mockResolvedValue([{ name: 'note.md', isDirectory: () => false }]),
      readFile: vi.fn().mockResolvedValue(Buffer.from('encrypted-bytes')),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn()
    };

    vi.doMock('fs', () => ({ promises: fspMock, existsSync }));

    // Mock encryption helpers
    vi.doMock('../ipc', () => ({
      isEncryptionEnabled: vi.fn().mockResolvedValue(true),
      getActiveMasterKey: vi.fn().mockReturnValue('master')
    }));
    vi.doMock('../crypto', () => ({
      decryptBuffer: vi.fn().mockReturnValue(Buffer.from('decrypted content'))
    }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { startIndexing, stopIndexing } = await import('../indexer');

    await startIndexing('/vault', mainWindow);

    // Grab the created fake worker
    const worker = global.__LAST_FAKE_WORKER__ as unknown as {
      posted?: Array<Record<string, unknown>>;
      emitMessage?: (msg: unknown) => void;
      terminated?: boolean;
    };
    expect(worker).toBeDefined();

    // Worker should have received posted files with decrypted content
    expect(worker.posted).toBeDefined();
    expect(worker.posted![0].content).toBe('decrypted content');

    // Simulate worker sending graph-complete
    worker.emitMessage?.({ type: 'graph-complete', data: { graph: { a: [] }, tasks: [] } });

    // mainWindow should have received graph and tasks updates
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:graph-update', { a: [] });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:tasks-update', []);

    // Now stop indexing
    stopIndexing();
    expect(worker.terminated).toBe(true);
  });

  it('startIndexing should fallback to plaintext when decryption fails', async () => {
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));

    class FakeWorker2 {
      handlers: Record<string, Array<(msg: unknown) => void>> = {} as Record<
        string,
        Array<(msg: unknown) => void>
      >;
      posted: Array<Record<string, unknown>> = [];
      terminated = false;
      constructor(_arg: unknown, _opts?: unknown) {
        void _arg;
        void _opts;
        // @ts-ignore Clearing global
        global.__LAST_FAKE_WORKER__ = this;
      }
      on(evt: string, cb: (msg: unknown) => void): void {
        (this.handlers[evt] ||= []).push(cb);
      }
      postMessage(msg: Array<Record<string, unknown>>): void {
        this.posted = msg;
      }
      terminate(): void {
        this.terminated = true;
      }
      emitMessage(msg: unknown): void {
        (this.handlers['message'] || []).forEach((cb: (msg: unknown) => void) => cb(msg));
      }
    }

    vi.doMock('worker_threads', () => ({ Worker: FakeWorker2 }));

    const existsSync = vi.fn().mockReturnValue(true);
    const fspMock: Partial<typeof import('fs').promises> = {
      readdir: vi.fn().mockResolvedValue([{ name: 'note.md', isDirectory: () => false }]),
      readFile: vi.fn().mockResolvedValue(Buffer.from('plain text')),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn()
    };

    vi.doMock('fs', () => ({ promises: fspMock, existsSync }));

    vi.doMock('../ipc', () => ({
      isEncryptionEnabled: vi.fn().mockResolvedValue(true),
      getActiveMasterKey: vi.fn().mockReturnValue('master')
    }));
    vi.doMock('../crypto', () => ({
      decryptBuffer: vi.fn().mockImplementation(() => {
        throw new Error('bad');
      })
    }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { startIndexing, stopIndexing } = await import('../indexer');

    await startIndexing('/vault', mainWindow);

    const worker = global.__LAST_FAKE_WORKER__ as unknown as {
      posted?: Array<Record<string, unknown>>;
      emitMessage?: (msg: unknown) => void;
      terminated?: boolean;
    };
    expect(worker.posted).toBeDefined();
    expect(worker.posted![0].content).toBe('plain text');

    worker.emitMessage?.({ type: 'graph-complete', data: { graph: {}, tasks: [] } });
    stopIndexing();
    expect(worker.terminated).toBe(true);
  });

  it('startIndexing should start worker, send files and handle graph-complete, then stopIndexing should terminate', async () => {
    // Fake Worker implementation
    class FakeWorker {
      handlers: Record<string, Array<(msg: unknown) => void>> = {} as Record<
        string,
        Array<(msg: unknown) => void>
      >;
      posted: Array<Record<string, unknown>> = [];
      terminated = false;
      constructor(_arg: unknown, _opts?: unknown) {
        void _arg;
        void _opts;
        // register globally so tests can access
        global.__LAST_FAKE_WORKER__ = this;
      }
      on(evt: string, cb: (msg: unknown) => void): void {
        (this.handlers[evt] ||= []).push(cb);
      }
      postMessage(msg: unknown): void {
        this.posted = msg as Array<Record<string, unknown>>;
      }
      terminate(): void {
        this.terminated = true;
      }
      // helper to simulate incoming message
      emitMessage(msg: unknown): void {
        (this.handlers['message'] || []).forEach((cb: (msg: unknown) => void) => cb(msg));
      }
    }

    // Mock worker_threads
    vi.doMock('worker_threads', () => ({ Worker: FakeWorker }));

    // Mock fs.existsSync to say worker file exists
    const existsSync = vi.fn().mockReturnValue(true);

    // Mock fsp.readdir to return one file
    const fspMock: Partial<typeof import('fs').promises> = {
      readdir: vi.fn().mockResolvedValue([{ name: 'note.md', isDirectory: () => false }]),
      readFile: vi.fn().mockResolvedValue(Buffer.from('content'))
    };

    vi.doMock('fs', () => ({ promises: fspMock, existsSync }));

    // Ensure encryption disabled for simplicity
    vi.doMock('../ipc', () => ({
      isEncryptionEnabled: vi.fn().mockResolvedValue(false),
      getActiveMasterKey: vi.fn()
    }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { startIndexing, stopIndexing } = await import('../indexer');

    await startIndexing('/vault', mainWindow);

    // Grab the created fake worker
    const worker = global.__LAST_FAKE_WORKER__ as unknown as {
      posted?: Array<Record<string, unknown>>;
      emitMessage?: (msg: unknown) => void;
      terminated?: boolean;
    };
    expect(worker).toBeDefined();

    // Worker should have received posted files
    expect(worker.posted).toBeDefined();
    expect(worker.posted!.length).toBe(1);

    // Simulate worker sending graph-complete
    worker.emitMessage?.({ type: 'graph-complete', data: { graph: { a: [] }, tasks: [] } });

    // mainWindow should have received graph and tasks updates
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:graph-update', { a: [] });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:tasks-update', []);

    // Now stop indexing
    stopIndexing();
    expect(worker.terminated).toBe(true);
  });
});

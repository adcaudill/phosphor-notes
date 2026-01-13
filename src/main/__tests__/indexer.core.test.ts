import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll dynamically import the module under test after setting up mocks

describe('indexer core helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear any global holder we use for the fake worker
    // @ts-ignore
    delete global.__LAST_FAKE_WORKER__;
  });

  it('startIndexing should send decrypted content when encryption enabled', async () => {
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));

    // Fake Worker implementation
    class FakeWorker {
      handlers: Record<string, Function[]> = {} as any;
      posted: any = null;
      terminated = false;
      constructor(_arg: any, _opts?: any) {
        // register globally so tests can access
        // @ts-ignore
        global.__LAST_FAKE_WORKER__ = this;
      }
      on(evt: string, cb: Function) {
        (this.handlers[evt] ||= []).push(cb);
      }
      postMessage(msg: any) {
        this.posted = msg;
      }
      terminate() {
        this.terminated = true;
      }
      // helper to simulate incoming message
      emitMessage(msg: any) {
        (this.handlers['message'] || []).forEach((cb: Function) => cb(msg));
      }
    }

    // Mock worker_threads
    vi.doMock('worker_threads', () => ({ Worker: FakeWorker }));

    // Mock fs and promises
    const existsSync = vi.fn().mockReturnValue(true);
    const fspMock: any = {
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

    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const { startIndexing, stopIndexing } = await import('../indexer');

    await startIndexing('/vault', mainWindow);

    // Grab the created fake worker
    // @ts-ignore
    const worker: any = global.__LAST_FAKE_WORKER__;
    expect(worker).toBeDefined();

    // Worker should have received posted files with decrypted content
    expect(worker.posted).toBeDefined();
    expect(worker.posted[0].content).toBe('decrypted content');

    // Simulate worker sending graph-complete
    worker.emitMessage({ type: 'graph-complete', data: { graph: { a: [] }, tasks: [] } });

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
      handlers: Record<string, Function[]> = {} as any;
      posted: any = null;
      terminated = false;
      constructor(_arg: any, _opts?: any) {
        // @ts-ignore
        global.__LAST_FAKE_WORKER__ = this;
      }
      on(evt: string, cb: Function) {
        (this.handlers[evt] ||= []).push(cb);
      }
      postMessage(msg: any) {
        this.posted = msg;
      }
      terminate() {
        this.terminated = true;
      }
      emitMessage(msg: any) {
        (this.handlers['message'] || []).forEach((cb: Function) => cb(msg));
      }
    }

    vi.doMock('worker_threads', () => ({ Worker: FakeWorker2 }));

    const existsSync = vi.fn().mockReturnValue(true);
    const fspMock: any = {
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

    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const { startIndexing, stopIndexing } = await import('../indexer');

    await startIndexing('/vault', mainWindow);

    // @ts-ignore
    const worker: any = global.__LAST_FAKE_WORKER__;
    expect(worker.posted[0].content).toBe('plain text');

    worker.emitMessage({ type: 'graph-complete', data: { graph: {}, tasks: [] } });
    stopIndexing();
    expect(worker.terminated).toBe(true);
  });

  it('startIndexing should start worker, send files and handle graph-complete, then stopIndexing should terminate', async () => {
    // Fake Worker implementation
    class FakeWorker {
      handlers: Record<string, Function[]> = {} as any;
      posted: any = null;
      terminated = false;
      constructor(_arg: any, _opts?: any) {
        // register globally so tests can access
        // @ts-ignore
        global.__LAST_FAKE_WORKER__ = this;
      }
      on(evt: string, cb: Function) {
        (this.handlers[evt] ||= []).push(cb);
      }
      postMessage(msg: any) {
        this.posted = msg;
      }
      terminate() {
        this.terminated = true;
      }
      // helper to simulate incoming message
      emitMessage(msg: any) {
        (this.handlers['message'] || []).forEach((cb: Function) => cb(msg));
      }
    }

    // Mock worker_threads
    vi.doMock('worker_threads', () => ({ Worker: FakeWorker }));

    // Mock fs.existsSync to say worker file exists
    const existsSync = vi.fn().mockReturnValue(true);

    // Mock fsp.readdir to return one file
    const fspMock: any = {
      readdir: vi.fn().mockResolvedValue([{ name: 'note.md', isDirectory: () => false }]),
      readFile: vi.fn().mockResolvedValue(Buffer.from('content'))
    };

    vi.doMock('fs', () => ({ promises: fspMock, existsSync }));

    // Ensure encryption disabled for simplicity
    vi.doMock('../ipc', () => ({
      isEncryptionEnabled: vi.fn().mockResolvedValue(false),
      getActiveMasterKey: vi.fn()
    }));

    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const { startIndexing, stopIndexing } = await import('../indexer');

    await startIndexing('/vault', mainWindow);

    // Grab the created fake worker
    // @ts-ignore
    const worker: any = global.__LAST_FAKE_WORKER__;
    expect(worker).toBeDefined();

    // Worker should have received posted files
    expect(worker.posted).toBeDefined();
    expect(worker.posted.length).toBe(1);

    // Simulate worker sending graph-complete
    worker.emitMessage({ type: 'graph-complete', data: { graph: { a: [] }, tasks: [] } });

    // mainWindow should have received graph and tasks updates
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:graph-update', { a: [] });
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:tasks-update', []);

    // Now stop indexing
    stopIndexing();
    expect(worker.terminated).toBe(true);
  });
});

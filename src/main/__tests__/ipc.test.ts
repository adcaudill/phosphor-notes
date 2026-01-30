import { describe, it, beforeEach, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

describe('ipc encryption flows', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('encryption:create writes security.json and encrypts markdown files', async () => {
    // prepare temporary vault and userData dirs
    const tmpPrefix = path.join(os.tmpdir(), 'phosphor-test-');
    const vaultDir = await fs.mkdtemp(tmpPrefix);
    const userDataDir = await fs.mkdtemp(tmpPrefix + 'user-');

    // create a sample markdown file
    const filePath = path.join(vaultDir, 'note.md');
    await fs.writeFile(filePath, 'hello world', 'utf-8');

    // mock indexer and watcher modules to avoid side effects
    vi.doMock('../indexer', () => ({
      startIndexing: vi.fn(),
      stopIndexing: vi.fn(),
      getLastGraph: vi.fn(() => null),
      getLastTasks: vi.fn(() => []),
      performSearch: vi.fn((_q: any, cb: any) => cb([])),
      updateTasksForFile: vi.fn()
    }));

    vi.doMock('../watcher', () => ({
      setupWatcher: vi.fn(),
      stopWatcher: vi.fn(),
      markInternalSave: vi.fn()
    }));

    // ipcMain mock to capture handlers
    const handlers: Record<string, Function> = {};
    const ipcMainMock = {
      handle: (channel: string, fn: Function) => {
        handlers[channel] = fn;
      },
      on: (_channel: string, _fn: Function) => {
        // No-op for event listeners in tests
      }
    } as any;

    // mock electron (must be before importing ipc module)
    vi.doMock('electron', () => ({
      ipcMain: ipcMainMock,
      dialog: { showOpenDialog: vi.fn() },
      BrowserWindow: class {},
      app: { getPath: () => userDataDir, getVersion: () => '1.2.3' }
    }));

    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any;

    const ipc = await import('../ipc');

    // register handlers
    ipc.setupIPC(mainWindow);

    // open the vault path (sets activeVaultPath)
    await ipc.openVaultPath(vaultDir, mainWindow);

    // Call encryption:create handler
    const createHandler = handlers['encryption:create'];
    expect(typeof createHandler).toBe('function');

    const res = await createHandler(null, 's3cret');
    expect(res).toBe(true);

    // security.json should exist
    const secPath = path.join(vaultDir, '.phosphor', 'security.json');
    const secRaw = await fs.readFile(secPath, 'utf-8');
    const sec = JSON.parse(secRaw);
    expect(sec.salt).toBeTruthy();
    expect(sec.checkToken).toBeTruthy();

    // note.md should now be encrypted (not plain UTF-8)
    const noteBuf = await fs.readFile(filePath);
    const noteText = noteBuf.toString('utf-8');
    // Encrypted data is unlikely to be valid UTF-8 equal to original
    expect(noteText).not.toBe('hello world');

    // verify decrypting using deriveMasterKey & decryptBuffer from crypto
    const { deriveMasterKey, decryptBuffer } = await import('../crypto');
    const salt = Buffer.from(sec.salt, 'base64');
    const mk = deriveMasterKey('s3cret', salt);
    const decrypted = decryptBuffer(noteBuf, mk);
    expect(decrypted.toString('utf-8')).toBe('hello world');
  });
});

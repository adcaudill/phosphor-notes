import { describe, it, beforeEach, vi, expect } from 'vitest';
import type { BrowserWindow } from 'electron';

describe('indexer.updateTasksForFile', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reads a file, extracts tasks, updates lastTasks and notifies window', async () => {
    // Prepare sample content with two tasks
    const sample = `# Title\n- [ ] first task\nSome text\n- [x] done task\n`;

    // Mock electron app.getPath used by ipc module (import-time)
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));

    // Mock fs.promises.readFile used in indexer (indexer imports { promises as fsp } from 'fs').
    // Real reads return a Buffer, which vaultReader's `isEncrypted` check
    // requires (it inspects the first bytes for a magic header).
    const fspMock: Partial<typeof import('fs').promises> = {
      readFile: vi.fn().mockResolvedValue(Buffer.from(sample))
    };

    vi.doMock('fs', () => ({ promises: fspMock }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { updateTasksForFile, getLastTasks } = await import('../indexer');

    await updateTasksForFile('/tmp/vault', 'note.md', mainWindow);

    // lastTasks should be populated and send called
    const tasks = getLastTasks();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks!.length).toBe(2);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('phosphor:tasks-update', tasks);
  });

  it('replaces previous tasks for same file', async () => {
    vi.resetModules();
    const firstContent = `- [ ] one\n`;
    const secondContent = `- [ ] two\n- [ ] three\n`;

    const readFileMock = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from(firstContent))
      .mockResolvedValueOnce(Buffer.from(secondContent));
    const fspMock: Partial<typeof import('fs').promises> = { readFile: readFileMock };

    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));

    // First call returns firstContent, second call returns secondContent

    vi.doMock('fs', () => ({ promises: fspMock }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { updateTasksForFile, getLastTasks } = await import('../indexer');

    await updateTasksForFile('/tmp/vault', 'a.md', mainWindow);
    let tasks = getLastTasks();
    expect(tasks!.length).toBe(1);

    await updateTasksForFile('/tmp/vault', 'a.md', mainWindow);
    tasks = getLastTasks();
    // Should now have 2 tasks replacing old file tasks
    expect(tasks!.length).toBe(2);
  });
});

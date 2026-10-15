import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

declare global {
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

// A fake worker that echoes back a `search-results` message carrying the
// same requestId it was sent, plus optional canned results per query - lets
// tests simulate two overlapping searches resolving out of order.
class EchoingFakeWorker {
  handlers: Record<string, Array<(msg: unknown) => void>> = {};
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  constructor(_arg: unknown, _opts?: unknown) {
    void _arg;
    void _opts;
    global.__LAST_FAKE_WORKER__ = this;
  }
  on(evt: string, cb: (msg: unknown) => void): void {
    (this.handlers[evt] ||= []).push(cb);
  }
  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  emitMessage(msg: unknown): void {
    (this.handlers['message'] || []).forEach((cb) => cb(msg));
  }
}

describe('indexer.searchAsync', () => {
  beforeEach(() => {
    vi.resetModules();
    delete global.__LAST_FAKE_WORKER__;
  });

  it('resolves concurrent searches with their own results, keyed by requestId', async () => {
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));
    vi.doMock('worker_threads', () => ({ Worker: EchoingFakeWorker }));

    const fspMock: Partial<typeof import('fs').promises> = {
      readdir: vi.fn().mockResolvedValue([])
    };
    vi.doMock('fs', () => ({ promises: fspMock, existsSync: vi.fn().mockReturnValue(true) }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const { startIndexing, searchAsync } = await import('../indexer');
    await startIndexing('/vault', mainWindow);

    const worker = global.__LAST_FAKE_WORKER__ as unknown as EchoingFakeWorker;
    expect(worker).toBeDefined();

    // Fire two searches "at once" (GUI + MCP), then respond out of order.
    const first = searchAsync('alpha');
    const second = searchAsync('beta');

    const posted = worker.posted as Array<{ type: string; query: string; requestId: string }>;
    const searchMsgs = posted.filter((m) => m.type === 'search');
    expect(searchMsgs).toHaveLength(2);
    const [alphaMsg, betaMsg] = searchMsgs;
    expect(alphaMsg.requestId).not.toBe(betaMsg.requestId);

    // Respond to the second request first, to prove results aren't just
    // matched to whichever call happened to be pending.
    worker.emitMessage({
      type: 'search-results',
      data: [{ id: 'beta-result' }],
      requestId: betaMsg.requestId
    });
    worker.emitMessage({
      type: 'search-results',
      data: [{ id: 'alpha-result' }],
      requestId: alphaMsg.requestId
    });

    await expect(first).resolves.toEqual([{ id: 'alpha-result' }]);
    await expect(second).resolves.toEqual([{ id: 'beta-result' }]);
  });

  it('resolves with an empty array if no response arrives before the timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));
      vi.doMock('worker_threads', () => ({ Worker: EchoingFakeWorker }));
      const fspMock: Partial<typeof import('fs').promises> = {
        readdir: vi.fn().mockResolvedValue([])
      };
      vi.doMock('fs', () => ({ promises: fspMock, existsSync: vi.fn().mockReturnValue(true) }));

      const mainWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as unknown as BrowserWindow;

      const { startIndexing, searchAsync } = await import('../indexer');
      await startIndexing('/vault', mainWindow);

      const resultPromise = searchAsync('never-answered', { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);

      await expect(resultPromise).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('indexer incremental search index updates', () => {
  beforeEach(() => {
    vi.resetModules();
    delete global.__LAST_FAKE_WORKER__;
  });

  async function setup(readFile: ReturnType<typeof vi.fn>): Promise<{
    indexer: typeof import('../indexer');
    worker: EchoingFakeWorker;
  }> {
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }));
    vi.doMock('worker_threads', () => ({ Worker: EchoingFakeWorker }));
    const fspMock: Partial<typeof import('fs').promises> = {
      readdir: vi.fn().mockResolvedValue([]),
      readFile: readFile as unknown as typeof import('fs').promises.readFile
    };
    vi.doMock('fs', () => ({ promises: fspMock, existsSync: vi.fn().mockReturnValue(true) }));

    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow;

    const indexer = await import('../indexer');
    await indexer.startIndexing('/vault', mainWindow);
    const worker = global.__LAST_FAKE_WORKER__ as unknown as EchoingFakeWorker;
    worker.posted.length = 0; // drop the initial batch
    return { indexer, worker };
  }

  it('posts the current file content to the worker', async () => {
    const { indexer, worker } = await setup(
      vi.fn().mockResolvedValue(Buffer.from('Freshservice call'))
    );
    await indexer.updateSearchIndexForFile('/vault', '2026-10-01.md');
    expect(worker.posted).toEqual([
      { type: 'index-file', filename: '2026-10-01.md', content: 'Freshservice call' }
    ]);
  });

  it('posts a removal when the file no longer exists', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const { indexer, worker } = await setup(vi.fn().mockRejectedValue(enoent));
    await indexer.updateSearchIndexForFile('/vault', 'MissionWire.md');
    expect(worker.posted).toEqual([{ type: 'remove-file', filename: 'MissionWire.md' }]);
  });

  it('posts a removal for removeFromSearchIndex', async () => {
    const { indexer, worker } = await setup(vi.fn());
    indexer.removeFromSearchIndex('MissionWire.md');
    expect(worker.posted).toEqual([{ type: 'remove-file', filename: 'MissionWire.md' }]);
  });

  it('ignores non-markdown files', async () => {
    const readFile = vi.fn();
    const { indexer, worker } = await setup(readFile);
    await indexer.updateSearchIndexForFile('/vault', '_assets/image.png');
    indexer.removeFromSearchIndex('_assets/image.png');
    expect(readFile).not.toHaveBeenCalled();
    expect(worker.posted).toEqual([]);
  });
});

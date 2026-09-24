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

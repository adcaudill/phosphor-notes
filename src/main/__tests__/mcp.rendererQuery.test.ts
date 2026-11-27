import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events');
  return { ipcMain: new EventEmitter() };
});

import { ipcMain } from 'electron';
import { queryNoteDirty } from '../mcp/rendererQuery';

/** A fake window whose renderer answers queries with `answer(path)` (or never, if it returns undefined). */
function fakeWindow(answer: (path: string) => boolean | undefined): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: { requestId: number; path: string }) => {
        expect(channel).toBe('mcp:query-note-dirty');
        const dirty = answer(payload.path);
        if (dirty !== undefined) {
          setTimeout(() =>
            (ipcMain as unknown as NodeJS.EventEmitter).emit(
              'mcp:note-dirty-result',
              {},
              { requestId: payload.requestId, dirty }
            )
          );
        }
      }
    }
  } as unknown as BrowserWindow;
}

describe('queryNoteDirty', () => {
  it("returns the renderer's answer for the queried path", async () => {
    const win = fakeWindow((p) => p === 'Open.md');
    expect(await queryNoteDirty(win, 'Open.md')).toBe(true);
    expect(await queryNoteDirty(win, 'Other.md')).toBe(false);
  });

  it('keeps concurrent queries apart', async () => {
    const win = fakeWindow((p) => p === 'A.md');
    const [a, b] = await Promise.all([queryNoteDirty(win, 'A.md'), queryNoteDirty(win, 'B.md')]);
    expect([a, b]).toEqual([true, false]);
  });

  it('fails open (not dirty) when the renderer never answers', async () => {
    const win = fakeWindow(() => undefined);
    expect(await queryNoteDirty(win, 'Open.md', 20)).toBe(false);
  });

  it('fails open with no window or a destroyed one', async () => {
    expect(await queryNoteDirty(null, 'Open.md')).toBe(false);
    const destroyed = { isDestroyed: () => true } as unknown as BrowserWindow;
    expect(await queryNoteDirty(destroyed, 'Open.md')).toBe(false);
  });
});

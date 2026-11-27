import { ipcMain, type BrowserWindow } from 'electron';

const QUERY_CHANNEL = 'mcp:query-note-dirty';
const RESULT_CHANNEL = 'mcp:note-dirty-result';
const DEFAULT_TIMEOUT_MS = 750;

const pending = new Map<number, (dirty: boolean) => void>();
let nextRequestId = 1;
let listening = false;

function ensureResultListener(): void {
  if (listening) return;
  listening = true;
  ipcMain.on(RESULT_CHANNEL, (_event, payload: { requestId?: unknown; dirty?: unknown }) => {
    const resolve = typeof payload?.requestId === 'number' && pending.get(payload.requestId);
    if (resolve) resolve(payload.dirty === true);
  });
}

/**
 * Asks the renderer whether `relPath` is the note currently open in the
 * editor *with unsaved changes* (typing within the last ~500ms autosave
 * debounce, or an unresolved conflict), so an MCP write can be refused
 * instead of racing the user's own autosave.
 *
 * Fails open: with no window, or no answer within `timeoutMs` (renderer
 * still loading, hung, or an older renderer without the handler), it
 * reports "not dirty" - the same behavior as before this check existed -
 * rather than blocking every AI write.
 */
export function queryNoteDirty(
  win: BrowserWindow | null,
  relPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  ensureResultListener();

  const requestId = nextRequestId++;
  return new Promise<boolean>((resolve) => {
    const finish = (dirty: boolean): void => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(dirty);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    pending.set(requestId, finish);
    try {
      win.webContents.send(QUERY_CHANNEL, { requestId, path: relPath });
    } catch {
      finish(false);
    }
  });
}

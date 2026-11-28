import type { BrowserWindow } from 'electron';
import {
  getLastGraph,
  updateGraphForFile,
  updateGraphForChangedFile,
  updateTasksForFile,
  updateSearchIndexForFile,
  removeFromSearchIndex
} from './indexer';
import { getMRUFiles, removeFromMRU, updateMRU } from './store';
import type { RenameNoteResult } from './vaultWriter';

/**
 * Side effects shared by every path that renames, moves, or deletes a note -
 * the app's own Rename/Move/Delete and MCP's move_note/delete_note - so the
 * indexes, recent-files list, and renderer all stay in step whichever one did
 * it. Failures are logged, never thrown: the file operation already happened.
 */

/**
 * Notes the link graph says link to any of `movedPaths` (or to anything under
 * them, for a note moved with its child notes) - the candidates whose links a
 * rename must rewrite. Null if the graph hasn't been built yet.
 */
export function findLinkCandidates(movedPaths: string[]): string[] | null {
  const graph = getLastGraph();
  if (!graph) return null;
  const exact = new Set(movedPaths);
  const prefixes = movedPaths.map((p) => p.replace(/\.md$/i, '') + '/');
  const out = new Set<string>();
  for (const [file, links] of Object.entries(graph)) {
    if (links.some((l) => exact.has(l) || prefixes.some((pre) => l.startsWith(pre)))) {
      out.add(file);
    }
  }
  return [...out].sort();
}

function send(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  } catch (err) {
    console.error(`[noteOps] failed to send ${channel}:`, err);
  }
}

export async function afterNoteRenamed(
  vaultPath: string,
  result: RenameNoteResult,
  win: BrowserWindow | null
): Promise<void> {
  const moves: Array<[string, string]> = [[result.from, result.to], ...result.movedChildren];

  // Tell the renderer first, so an open note switches to its new path (instead
  // of seeing "deleted" and clearing the editor) before any change events for it.
  for (const [from, to] of moves) send(win, 'vault:file-renamed', from, to);
  for (const stub of result.parentsCreated) send(win, 'vault:file-added', stub);

  try {
    const mru = await getMRUFiles(vaultPath);
    for (const [from, to] of moves) {
      if (mru.includes(from)) {
        await removeFromMRU(vaultPath, from);
        await updateMRU(vaultPath, to);
      }
    }
  } catch (err) {
    console.error('[noteOps] MRU update after rename failed:', err);
  }

  try {
    for (const [from, to] of moves) {
      removeFromSearchIndex(from);
      await updateSearchIndexForFile(vaultPath, to);
    }
    for (const stub of result.parentsCreated) await updateSearchIndexForFile(vaultPath, stub);
    for (const { path } of result.linksUpdated) await updateSearchIndexForFile(vaultPath, path);
  } catch (err) {
    console.error('[noteOps] search index update after rename failed:', err);
  }

  // Graph/task updates need the initial full index (see deps.notifyNoteWritten).
  if (win && !win.isDestroyed() && getLastGraph() !== null) {
    try {
      for (const stub of result.parentsCreated) await updateGraphForFile(vaultPath, stub, win);
      for (const [, to] of moves) {
        await updateGraphForFile(vaultPath, to, win);
        await updateTasksForFile(vaultPath, to, win);
      }
      for (const { path } of result.linksUpdated) {
        await updateGraphForChangedFile(vaultPath, path, win);
        await updateTasksForFile(vaultPath, path, win);
      }
    } catch (err) {
      console.error('[noteOps] graph/task update after rename failed:', err);
    }
  }

  for (const { path } of result.linksUpdated) send(win, 'vault:file-changed', path);
}

export async function afterNoteDeleted(
  vaultPath: string,
  relPath: string,
  win: BrowserWindow | null
): Promise<void> {
  removeFromSearchIndex(relPath);
  send(win, 'vault:file-deleted', relPath);
  try {
    await removeFromMRU(vaultPath, relPath);
  } catch (err) {
    console.error('[noteOps] MRU update after delete failed:', err);
  }
}

import { app, type BrowserWindow } from 'electron';
import * as vaultState from '../vaultState';
import {
  getLastGraph,
  getLastTasks,
  searchAsync,
  updateGraphForFile,
  updateGraphForChangedFile,
  updateTasksForFile,
  schedulePredictionModelUpdate
} from '../indexer';
import * as vaultReader from '../vaultReader';
import { VaultNotOpenError, type NoteInfo } from '../vaultReader';
import * as vaultWriter from '../vaultWriter';
import { getSettings } from '../store';
import { localDailyNoteFilename, type NoteMode } from '../../shared/noteFormat';
import type { Task, UserSettings } from '../../types/phosphor.d';
import type { WikiGraph } from '../graphBuilder';

/**
 * Dependency-injection seam between MCP tool handlers and the rest of the
 * app: tools depend on this interface, not on Electron singletons or the
 * vaultState/indexer modules directly, so they can be unit-tested with the
 * MCP SDK's in-memory transport and a fake implementation.
 */
export interface McpDeps {
  getVaultPath(): string | null;
  isReadable(): Promise<boolean>;
  isEncryptionEnabled(vaultPath: string): Promise<boolean>;
  getGeneration(): number;
  isIndexReady(): boolean;
  getAppVersion(): string;
  listNotes(folder?: string): Promise<NoteInfo[]>;
  readNote(relPath: string): Promise<string>;
  searchNotes(query: string): Promise<unknown[]>;
  getTasks(): Task[] | null;
  getGraph(): WikiGraph | null;

  isWriteEnabled(): boolean;
  getDefaultJournalMode(): Promise<NoteMode>;
  /** `YYYY-MM-DD.md` for today, local date. */
  todayDailyNotePath(): string;
  createNote(
    relPath: string,
    body: string,
    opts: { mode?: NoteMode; overwrite?: boolean },
    ctx: { generation: number }
  ): Promise<vaultWriter.CreateNoteResult>;
  appendToNote(
    relPath: string,
    addition: string,
    ctx: { generation: number },
    createIfMissing?: { frontmatter: string }
  ): Promise<vaultWriter.AppendResult>;
  insertUnderBullet(
    relPath: string,
    matchText: string,
    addition: string,
    ctx: { generation: number },
    opts?: { occurrence?: number }
  ): Promise<vaultWriter.InsertUnderBulletResult>;
  replaceLines(
    relPath: string,
    target: { line: number; expectedText: string },
    newLines: string[],
    ctx: { generation: number }
  ): Promise<vaultWriter.ReplaceLinesResult>;
}

function requireVaultPath(): string {
  const vp = vaultState.getVaultPath();
  if (!vp) throw new VaultNotOpenError();
  return vp;
}

/**
 * Runs the same post-write refresh the GUI's own explicit-update handlers
 * (note:rename/note:move) do, plus notifies the renderer - going a step
 * further than note:save, which relies entirely on the chokidar watcher's
 * debounced callback (a global, cross-file grace window that can
 * misclassify an MCP write as "internal" and suppress the renderer
 * notification if the user happens to be typing in any other note; see
 * vaultWriter's design notes). Failures here are logged, never thrown -
 * the write itself already succeeded by the time this runs.
 */
async function afterNoteWritten(
  vaultPath: string,
  rel: string,
  info: { created: boolean; parentsCreated: string[] },
  win: BrowserWindow | null
): Promise<void> {
  if (!win || win.isDestroyed()) return;

  try {
    // Only refresh the task/graph index once the initial full index has
    // completed - updateTasksForFile has no "not ready yet" guard (unlike
    // its graph-update sibling) and would otherwise make list_tasks think
    // an incomplete, one-file task list is the whole vault.
    if (getLastGraph() !== null) {
      for (const p of info.parentsCreated) {
        await updateGraphForFile(vaultPath, p, win);
      }
      if (info.created) {
        await updateGraphForFile(vaultPath, rel, win);
      } else {
        await updateGraphForChangedFile(vaultPath, rel, win);
      }
      await updateTasksForFile(vaultPath, rel, win);
      schedulePredictionModelUpdate(vaultPath, rel, win);
    }
  } catch (err) {
    console.error('[MCP] post-write index refresh failed:', err);
  }

  try {
    for (const p of info.parentsCreated) {
      win.webContents.send('vault:file-added', p);
    }
    win.webContents.send(info.created ? 'vault:file-added' : 'vault:file-changed', rel);
  } catch (err) {
    console.error('[MCP] post-write notify failed:', err);
  }
}

export interface BuildDepsOptions {
  isWriteEnabled: () => boolean;
  getMainWindow: () => BrowserWindow | null;
}

export function buildDefaultDeps(opts: BuildDepsOptions): McpDeps {
  return {
    getVaultPath: () => vaultState.getVaultPath(),
    isReadable: () => vaultState.isReadable(),
    isEncryptionEnabled: (vaultPath: string) => vaultState.isEncryptionEnabled(vaultPath),
    getGeneration: () => vaultState.getGeneration(),
    isIndexReady: () => getLastGraph() !== null,
    getAppVersion: () => app.getVersion(),
    listNotes: (folder?: string) => vaultReader.listNotes(requireVaultPath(), folder),
    readNote: (relPath: string) => vaultReader.readNoteText(requireVaultPath(), relPath),
    // AND-combine: an MCP caller wants precise, all-tokens-must-match
    // results (e.g. searching a full email address), not the GUI
    // omni-search's forgiving OR-of-tokens default - which is left
    // untouched since this is the only caller of McpDeps.searchNotes.
    searchNotes: (query: string) => searchAsync(query, { timeoutMs: 5000, combineWith: 'AND' }),
    getTasks: () => getLastTasks(),
    getGraph: () => getLastGraph(),

    isWriteEnabled: opts.isWriteEnabled,
    getDefaultJournalMode: async () => {
      const settings: UserSettings = await getSettings();
      return settings.defaultJournalMode;
    },
    todayDailyNotePath: () => localDailyNoteFilename(),

    createNote: async (relPath, body, createOpts, ctx) => {
      const vp = requireVaultPath();
      const result = await vaultWriter.createNote(vp, relPath, body, {
        mode: createOpts.mode,
        overwrite: createOpts.overwrite,
        expectedGeneration: ctx.generation
      });
      await afterNoteWritten(vp, relPath, result, opts.getMainWindow());
      return result;
    },

    appendToNote: async (relPath, addition, ctx, createIfMissing) => {
      const vp = requireVaultPath();
      const result = await vaultWriter.appendToNote(vp, relPath, addition, {
        expectedGeneration: ctx.generation,
        createIfMissing
      });
      await afterNoteWritten(vp, relPath, result, opts.getMainWindow());
      return result;
    },

    insertUnderBullet: async (relPath, matchText, addition, ctx, insertOpts) => {
      const vp = requireVaultPath();
      const result = await vaultWriter.insertUnderBullet(vp, relPath, matchText, addition, {
        expectedGeneration: ctx.generation,
        occurrence: insertOpts?.occurrence
      });
      // Never creates the note or any parent stubs.
      await afterNoteWritten(vp, relPath, { created: false, parentsCreated: [] }, opts.getMainWindow());
      return result;
    },

    replaceLines: async (relPath, target, newLines, ctx) => {
      const vp = requireVaultPath();
      const result = await vaultWriter.replaceLines(vp, relPath, target, newLines, {
        expectedGeneration: ctx.generation
      });
      // Never creates the note or any parent stubs.
      await afterNoteWritten(vp, relPath, { created: false, parentsCreated: [] }, opts.getMainWindow());
      return result;
    }
  };
}

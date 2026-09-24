import { app } from 'electron';
import * as vaultState from '../vaultState';
import { getLastGraph, getLastTasks, searchAsync } from '../indexer';
import * as vaultReader from '../vaultReader';
import { VaultNotOpenError, type NoteInfo } from '../vaultReader';
import type { Task } from '../../types/phosphor.d';
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
}

function requireVaultPath(): string {
  const vp = vaultState.getVaultPath();
  if (!vp) throw new VaultNotOpenError();
  return vp;
}

export function buildDefaultDeps(): McpDeps {
  return {
    getVaultPath: () => vaultState.getVaultPath(),
    isReadable: () => vaultState.isReadable(),
    isEncryptionEnabled: (vaultPath: string) => vaultState.isEncryptionEnabled(vaultPath),
    getGeneration: () => vaultState.getGeneration(),
    isIndexReady: () => getLastGraph() !== null,
    getAppVersion: () => app.getVersion(),
    listNotes: (folder?: string) => vaultReader.listNotes(requireVaultPath(), folder),
    readNote: (relPath: string) => vaultReader.readNoteText(requireVaultPath(), relPath),
    searchNotes: (query: string) => searchAsync(query, { timeoutMs: 5000 }),
    getTasks: () => getLastTasks(),
    getGraph: () => getLastGraph()
  };
}

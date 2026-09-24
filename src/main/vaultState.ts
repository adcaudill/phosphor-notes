import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import * as path from 'path';
import sodium from 'sodium-native';

// Single source of truth for "which vault is open" and "is it currently
// unlocked", shared by the IPC handlers, the indexer, and (new) the MCP
// server. Previously this state lived only as module-level variables inside
// ipc.ts, which forced indexer.ts to import from ipc.ts to read it - an
// import cycle. Centralizing it here breaks that cycle and gives any new
// consumer (like MCP tools) one place to ask "can I read the vault right now?"

export type VaultChangeReason = 'opened' | 'switched' | 'closed' | 'unlocked' | 'locked';

export interface VaultChangeEvent {
  reason: VaultChangeReason;
  generation: number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let vaultPath: string | null = null;
let masterKey: Buffer | null = null;
let generation = 0;

function bump(reason: VaultChangeReason): void {
  generation += 1;
  emitter.emit('changed', { reason, generation } satisfies VaultChangeEvent);
}

function clearMasterKeyInternal(): boolean {
  if (!masterKey) return false;
  sodium.sodium_memzero(masterKey);
  masterKey = null;
  return true;
}

export function getVaultPath(): string | null {
  return vaultPath;
}

export function getMasterKey(): Buffer | null {
  return masterKey;
}

export function getGeneration(): number {
  return generation;
}

/** Subscribe to vault state changes. Returns an unsubscribe function. */
export function onChange(cb: (event: VaultChangeEvent) => void): () => void {
  emitter.on('changed', cb);
  return () => emitter.off('changed', cb);
}

function getSecurityConfigPath(vp: string): string {
  return path.join(vp, '.phosphor', 'security.json');
}

/** Disk check: does this vault path have encryption configured (a security.json present)? */
export async function isEncryptionEnabled(vp: string): Promise<boolean> {
  try {
    await fsp.access(getSecurityConfigPath(vp));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the currently-open vault can be read right now: a vault must be
 * open, and if it's encrypted, a master key must currently be held in memory.
 * Note this does NOT mean previously-cached data (search index, graph, task
 * list) is safe to serve - those caches are not cleared on lock today and
 * callers that expose cached data must gate on this check themselves rather
 * than on whether the cache happens to be populated.
 */
export async function isReadable(): Promise<boolean> {
  if (!vaultPath) return false;
  if (masterKey) return true;
  return !(await isEncryptionEnabled(vaultPath));
}

/** Open, switch to, or close (pass null) a vault. Clears any previous master key. */
export function setVaultPath(newPath: string | null): void {
  const reason: VaultChangeReason =
    newPath === null ? 'closed' : vaultPath === null ? 'opened' : 'switched';
  vaultPath = newPath;
  clearMasterKeyInternal();
  bump(reason);
}

/** Record a successfully-derived master key after a password unlock. */
export function setMasterKey(key: Buffer): void {
  masterKey = key;
  bump('unlocked');
}

/** Zero and clear the in-memory master key. Returns true if a key was actually cleared. */
export function clearMasterKey(): boolean {
  const cleared = clearMasterKeyInternal();
  if (cleared) bump('locked');
  return cleared;
}

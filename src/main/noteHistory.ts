import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { writeFileAtomic } from './atomicWrite';

/**
 * Per-vault history of note versions replaced by MCP writes, so every change
 * an AI client makes can be inspected and reverted. Lives in the vault's own
 * `.phosphor/history/` (so it travels with the vault, and is invisible to the
 * vault listing, the watcher, and MCP path rules, which all skip dot-folders).
 *
 * Snapshots are the note's exact on-disk bytes - an encrypted note's snapshot
 * stays encrypted - plus a small JSON index of metadata (path, time, which
 * tool replaced it, a content-free summary). Note paths are already plaintext
 * filenames on disk, so the index reveals nothing the vault doesn't.
 */

export interface HistoryEntry {
  id: string;
  /** ISO timestamp of when this version was replaced. */
  ts: string;
  /** Vault-relative path of the note this is a version of. */
  path: string;
  /** What replaced it, e.g. "edit_note" or "revert (app)". */
  tool: string;
  /** Short, content-free description of the change, e.g. "2 edits". */
  summary?: string;
  /** Size in bytes of the snapshot. */
  size: number;
}

export const MAX_HISTORY_ENTRIES = 500;
export const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ID_RE = /^\d{13}-[0-9a-f]{8}$/;

export class VersionNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(
      `No saved version with id "${id}" (it may have expired - versions are kept for 30 days).`
    );
    this.name = 'VersionNotFoundError';
  }
}

function historyDir(vaultPath: string): string {
  return path.join(vaultPath, '.phosphor', 'history');
}

function indexPath(vaultPath: string): string {
  return path.join(historyDir(vaultPath), 'index.json');
}

function snapshotPath(vaultPath: string, id: string): string {
  return path.join(historyDir(vaultPath), `${id}.snap`);
}

async function readIndex(vaultPath: string): Promise<HistoryEntry[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath(vaultPath), 'utf-8'));
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is HistoryEntry =>
            e && typeof e.id === 'string' && ID_RE.test(e.id) && typeof e.path === 'string'
        )
      : [];
  } catch {
    return [];
  }
}

// Index updates are read-modify-write; serialize them so two concurrent
// snapshots can't drop each other's entries.
let indexQueue: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(fn, fn);
  indexQueue = run.catch(() => {});
  return run;
}

function prune(
  entries: HistoryEntry[],
  now: number
): { kept: HistoryEntry[]; dropped: HistoryEntry[] } {
  const fresh = entries.filter((e) => now - Date.parse(e.ts) <= MAX_HISTORY_AGE_MS);
  const kept = fresh.slice(-MAX_HISTORY_ENTRIES);
  const keptIds = new Set(kept.map((e) => e.id));
  return { kept, dropped: entries.filter((e) => !keptIds.has(e.id)) };
}

/** Saves `raw` (a note's bytes as they are on disk, before a write replaces them) and returns its history entry. */
export async function recordSnapshot(
  vaultPath: string,
  snap: { path: string; raw: Buffer; tool: string; summary?: string }
): Promise<HistoryEntry> {
  const now = Date.now();
  const entry: HistoryEntry = {
    id: `${now}-${randomBytes(4).toString('hex')}`,
    ts: new Date(now).toISOString(),
    path: snap.path,
    tool: snap.tool,
    summary: snap.summary,
    size: snap.raw.length
  };

  await fsp.mkdir(historyDir(vaultPath), { recursive: true });
  await writeFileAtomic(snapshotPath(vaultPath, entry.id), snap.raw);

  await withIndexLock(async () => {
    const { kept, dropped } = prune([...(await readIndex(vaultPath)), entry], now);
    await writeFileAtomic(indexPath(vaultPath), JSON.stringify(kept, null, 2));
    await Promise.all(
      dropped.map((e) => fsp.unlink(snapshotPath(vaultPath, e.id)).catch(() => {}))
    );
  });

  return entry;
}

/** Saved versions, newest first, optionally for one note only. */
export async function listVersions(
  vaultPath: string,
  opts: { path?: string; limit?: number } = {}
): Promise<HistoryEntry[]> {
  const entries = await readIndex(vaultPath);
  const filtered = opts.path ? entries.filter((e) => e.path === opts.path) : entries;
  return filtered.reverse().slice(0, opts.limit ?? 50);
}

/** One saved version's metadata and exact bytes. */
export async function readVersion(
  vaultPath: string,
  id: string
): Promise<{ entry: HistoryEntry; raw: Buffer }> {
  if (!ID_RE.test(id)) throw new VersionNotFoundError(id);
  const entry = (await readIndex(vaultPath)).find((e) => e.id === id);
  if (!entry) throw new VersionNotFoundError(id);
  try {
    return { entry, raw: await fsp.readFile(snapshotPath(vaultPath, id)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new VersionNotFoundError(id);
    throw err;
  }
}

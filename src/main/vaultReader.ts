import { promises as fsp } from 'fs';
import * as path from 'path';
import { decryptBuffer, isEncrypted } from './crypto';
import * as vaultState from './vaultState';
import { resolveReadableNotePath, resolveReadableFolderPath, PathNotAllowedError } from './vaultPaths';

export { PathNotAllowedError };

export class VaultNotOpenError extends Error {
  constructor() {
    super('No vault is open');
    this.name = 'VaultNotOpenError';
  }
}

export class VaultLockedError extends Error {
  constructor(public readonly path: string) {
    super(`Vault is locked; cannot decrypt ${path}`);
    this.name = 'VaultLockedError';
  }
}

export class NoteNotFoundError extends Error {
  constructor(public readonly relPath: string) {
    super(`Note not found: ${relPath}`);
    this.name = 'NoteNotFoundError';
  }
}

export class DecryptError extends Error {
  constructor(
    public readonly path: string,
    cause?: unknown
  ) {
    super(`Failed to decrypt ${path}`);
    this.name = 'DecryptError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Transparently decrypts `buffer` if it carries the vault's encryption
 * magic header (see crypto.ts's `isEncrypted`) - the shared decode step
 * behind `readDecrypted`, extracted so callers that already have the raw
 * bytes in hand (e.g. `vaultWriter.ts`, checking whether a file being
 * overwritten was encrypted) don't need to re-read the file to decode it.
 * Checks the file's own header rather than a vault-wide "encryption
 * enabled" flag, so it behaves correctly for encrypted, plain, and mixed
 * vaults alike, and throws instead of ever returning ciphertext as if it
 * were plaintext.
 */
export function decodeBuffer(buffer: Buffer, absPath: string): Buffer {
  if (!isEncrypted(buffer)) return buffer;

  // Fetch the key *after* the read completes: holding a reference to it
  // across an earlier await would risk using a buffer that a concurrent
  // vault lock has already zeroed in place. Callers that read `buffer`
  // themselves must likewise call this synchronously, right after the
  // read, with no `await` in between.
  const key = vaultState.getMasterKey();
  if (!key) {
    throw new VaultLockedError(absPath);
  }
  try {
    return decryptBuffer(buffer, key);
  } catch (err) {
    throw new DecryptError(absPath, err);
  }
}

/** Reads a file's raw bytes and decodes them via `decodeBuffer`. The one shared decrypt-on-read path. */
export async function readDecrypted(absPath: string): Promise<Buffer> {
  const buffer = await fsp.readFile(absPath);
  return decodeBuffer(buffer, absPath);
}

export interface NoteInfo {
  /** Vault-relative path, forward slashes, including the .md extension. */
  path: string;
  modified: string; // ISO timestamp
  size: number; // on-disk (possibly ciphertext) size in bytes
}

/**
 * Read one note's decrypted text content by vault-relative path.
 * Never creates the file - unlike the GUI's `note:read` IPC handler, a
 * read-only caller (MCP) must not have file-creation side effects.
 */
export async function readNoteText(vaultPath: string, relPath: string): Promise<string> {
  const absPath = await resolveReadableNotePath(vaultPath, relPath);
  try {
    const buffer = await readDecrypted(absPath);
    return buffer.toString('utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new NoteNotFoundError(relPath);
    }
    throw err;
  }
}

async function walk(root: string, dir: string, out: NoteInfo[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // hidden files/dirs, incl. .phosphor
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, out);
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.md') || lower.endsWith('.bak')) continue;
    const stat = await fsp.stat(fullPath);
    out.push({
      path: path.relative(root, fullPath).split(path.sep).join('/'),
      modified: stat.mtime.toISOString(),
      size: stat.size
    });
  }
}

/** List all notes in the vault (or a subfolder), skipping dotfiles/dirs and .bak files. */
export async function listNotes(vaultPath: string, folder?: string): Promise<NoteInfo[]> {
  const root = await resolveReadableFolderPath(vaultPath, folder);
  const out: NoteInfo[] = [];
  await walk(vaultPath, root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

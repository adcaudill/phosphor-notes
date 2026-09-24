import { promises as fsp } from 'fs';
import * as path from 'path';

/**
 * Safely resolve a filename relative to the vault, preventing directory traversal attacks.
 * Allows nested paths like "People/John.md" but rejects "../../../etc/passwd".
 *
 * This is the original GUI-facing guard (moved here unchanged from ipc.ts). It
 * trusts the caller more than `resolveReadableNotePath` below: it doesn't
 * check file extension, hidden segments, or symlinks, because it's used for
 * operations the user themselves triggered (open a vault they picked via an
 * OS folder dialog, then click/rename/move files inside it).
 */
export function validateAndResolvePath(vaultPath: string, filename: string): string {
  const resolvedVault = path.resolve(vaultPath);
  const resolvedPath = path.resolve(vaultPath, filename);

  if (!resolvedPath.startsWith(resolvedVault + path.sep) && resolvedPath !== resolvedVault) {
    throw new Error('Path traversal attempt detected');
  }

  return resolvedPath;
}

export class PathNotAllowedError extends Error {
  constructor(
    public readonly relPath: string,
    reason: string
  ) {
    super(`Path not allowed: ${relPath} (${reason})`);
    this.name = 'PathNotAllowedError';
  }
}

function rejectUnsafeSegments(rel: string): string {
  if (!rel || typeof rel !== 'string') {
    throw new PathNotAllowedError(String(rel), 'empty path');
  }
  if (rel.includes('\0')) {
    throw new PathNotAllowedError(rel, 'null byte');
  }
  const normalized = rel.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new PathNotAllowedError(rel, 'absolute path');
  }
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.some((seg) => seg === '..')) {
    throw new PathNotAllowedError(rel, 'parent traversal');
  }
  if (segments.some((seg) => seg.startsWith('.'))) {
    throw new PathNotAllowedError(rel, 'hidden path segment');
  }
  return normalized;
}

async function resolveWithSymlinkCheck(vaultPath: string, resolved: string, rel: string): Promise<string> {
  let realVault: string;
  try {
    realVault = await fsp.realpath(vaultPath);
  } catch {
    throw new PathNotAllowedError(rel, 'vault path not accessible');
  }

  let realResolved: string;
  try {
    realResolved = await fsp.realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // The target doesn't exist. Nothing to resolve yet - let the caller's
      // own read surface a "not found" error rather than treating this as a
      // path-safety violation.
      return resolved;
    }
    throw new PathNotAllowedError(rel, 'failed to resolve path');
  }

  if (!realResolved.startsWith(realVault + path.sep) && realResolved !== realVault) {
    throw new PathNotAllowedError(rel, 'resolves outside the vault');
  }

  return resolved;
}

/**
 * A stricter path resolver for read-only, externally-triggered access (MCP
 * tools): rejects absolute paths, hidden/dot segments (blocks `.phosphor/`,
 * `.git/`), non-`.md` files, and `.bak` files, then verifies via
 * `fs.realpath` that a symlink inside the vault doesn't point outside it -
 * a gap `validateAndResolvePath` above doesn't cover.
 */
export async function resolveReadableNotePath(vaultPath: string, rel: string): Promise<string> {
  const normalized = rejectUnsafeSegments(rel);
  const lower = normalized.toLowerCase();
  if (!lower.endsWith('.md') || lower.endsWith('.bak')) {
    throw new PathNotAllowedError(rel, 'only .md notes are readable');
  }

  const resolved = validateAndResolvePath(vaultPath, normalized);
  return resolveWithSymlinkCheck(vaultPath, resolved, rel);
}

/**
 * The folder-listing counterpart of `resolveReadableNotePath`: same
 * hidden-segment/traversal/symlink rules, but no file-extension requirement,
 * and an empty/undefined folder resolves to the vault root.
 */
export async function resolveReadableFolderPath(vaultPath: string, folder?: string): Promise<string> {
  if (!folder) {
    return resolveWithSymlinkCheck(vaultPath, path.resolve(vaultPath), '.');
  }
  const normalized = rejectUnsafeSegments(folder);
  const resolved = validateAndResolvePath(vaultPath, normalized);
  return resolveWithSymlinkCheck(vaultPath, resolved, folder);
}

/**
 * Folder-level write scoping for MCP write tools. The user can restrict
 * writes to an allow-list of folders and/or exclude a deny-list; the deny
 * list always wins. A folder's own index note (`People.md` for the `People`
 * folder - the stub the app creates for nested notes) counts as part of the
 * folder. Matching is case-insensitive, so a deny entry can't be sidestepped
 * on a case-insensitive filesystem (macOS/Windows) by changing case.
 */

export interface WriteScope {
  /** Empty means "anywhere in the vault" (subject to `deny`). */
  allow: string[];
  deny: string[];
}

export const UNRESTRICTED_SCOPE: WriteScope = { allow: [], deny: [] };

export class PathNotInWriteScopeError extends Error {
  constructor(
    public readonly relPath: string,
    reason: string
  ) {
    super(`${relPath} is outside the folders AI apps are allowed to change (${reason}).`);
    this.name = 'PathNotInWriteScopeError';
  }
}

/** Normalizes one user-entered folder ("Projects\\Work/", "/Inbox") to "Projects/Work" / "Inbox"; null if it isn't a usable vault-relative folder. */
export function normalizeFolder(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const segments = input
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;
  return segments.join('/');
}

/** Normalizes and de-duplicates (case-insensitively) a folder list, dropping unusable entries. */
export function normalizeFolderList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const folder = normalizeFolder(item);
    if (folder && !seen.has(folder.toLowerCase())) {
      seen.add(folder.toLowerCase());
      out.push(folder);
    }
  }
  return out;
}

function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

/** True if `relPath` is inside `folder`, or is that folder's own index note. */
export function isWithinFolder(relPath: string, folder: string): boolean {
  const rel = normalizeRelPath(relPath).toLowerCase();
  const f = folder.toLowerCase();
  return rel === `${f}.md` || rel.startsWith(`${f}/`);
}

export function isInWriteScope(relPath: string, scope: WriteScope): boolean {
  if (scope.deny.some((f) => isWithinFolder(relPath, f))) return false;
  if (scope.allow.length === 0) return true;
  return scope.allow.some((f) => isWithinFolder(relPath, f));
}

export function assertInWriteScope(relPath: string, scope: WriteScope): void {
  const denied = scope.deny.find((f) => isWithinFolder(relPath, f));
  if (denied) {
    throw new PathNotInWriteScopeError(relPath, `the "${denied}" folder is excluded`);
  }
  if (scope.allow.length > 0 && !scope.allow.some((f) => isWithinFolder(relPath, f))) {
    throw new PathNotInWriteScopeError(
      relPath,
      `changes are limited to: ${scope.allow.map((f) => `"${f}"`).join(', ')}`
    );
  }
}

import { promises as fsp } from 'fs';
import * as path from 'path';
import { encryptBuffer, isEncrypted } from './crypto';
import * as vaultState from './vaultState';
import { resolveWritableNotePath } from './vaultPaths';
import {
  decodeBuffer,
  VaultLockedError,
  NoteNotFoundError,
  DecryptError,
  PathNotAllowedError
} from './vaultReader';
import {
  buildNewNoteDoc,
  detectNoteMode,
  formatAppend,
  hasOwnFrontmatter,
  insertUnderBullet as formatInsertUnderBullet,
  InvalidArgumentError,
  NotOutlinerModeError,
  BulletNotFoundError,
  AmbiguousMatchError,
  type NoteMode
} from '../shared/noteFormat';

export {
  VaultLockedError,
  NoteNotFoundError,
  DecryptError,
  PathNotAllowedError,
  InvalidArgumentError,
  NotOutlinerModeError,
  BulletNotFoundError,
  AmbiguousMatchError
};

export class NoteAlreadyExistsError extends Error {
  constructor(public readonly relPath: string) {
    super(`Note already exists: ${relPath}`);
    this.name = 'NoteAlreadyExistsError';
  }
}

export class VaultStateChangedError extends Error {
  constructor() {
    super('The vault was locked, switched, or closed while this write was in progress; nothing was written');
    this.name = 'VaultStateChangedError';
  }
}

const MAX_CREATE_BODY_CHARS = 200_000;
const MAX_APPEND_CHARS = 100_000;

interface EncodeOptions {
  /** Encrypt even if the vault's own config doesn't currently say so (e.g. the existing file was already encrypted). */
  forceEncrypt?: boolean;
  /** Aborts with VaultStateChangedError if the vault's generation has moved on since the caller captured it. */
  expectedGeneration?: number;
}

/**
 * Encodes `plaintext` for disk. Unlike the GUI's `note:save` (which encrypts
 * only `if (activeMasterKey)`, silently falling back to plaintext if the
 * vault is configured-encrypted but momentarily locked), this decides
 * encryption from the vault's actual configured state - so a lock race can
 * never cause a silent plaintext write into an encrypted vault. The
 * generation check, key fetch, and `encryptBuffer` call all happen in one
 * synchronous section with no `await` between them, so a concurrent
 * `clearMasterKey()` (which zeroes the key buffer in place) cannot corrupt
 * the encryption. The caller must `fsp.writeFile` the result immediately,
 * with no `await` in between.
 */
export async function encodeForVault(
  vaultPath: string,
  plaintext: Buffer,
  opts: EncodeOptions = {}
): Promise<Buffer> {
  const shouldEncrypt = opts.forceEncrypt || (await vaultState.isEncryptionEnabled(vaultPath));

  // ---- synchronous section: no `await` below until the caller's writeFile ----
  if (opts.expectedGeneration !== undefined && vaultState.getGeneration() !== opts.expectedGeneration) {
    throw new VaultStateChangedError();
  }
  if (!shouldEncrypt) return plaintext;
  const key = vaultState.getMasterKey();
  if (!key) {
    throw new VaultLockedError(vaultPath);
  }
  return encryptBuffer(plaintext, key);
}

/**
 * Auto-creates empty parent-namespace stub files for a nested path, e.g.
 * creating `People/John/Notes.md` also creates stub `People.md` and
 * `People/John.md` if they don't already exist - mirroring the GUI's
 * behavior (moved here from `ipc.ts`, which now imports this). Returns the
 * vault-relative stub paths actually created (used to trigger a graph
 * update for each). Uses `{flag:'wx'}` so a stub concurrently created by
 * another write can never be clobbered with an empty file, and skips (logs,
 * doesn't throw) a stub whose encoding fails - e.g. a locked encrypted
 * vault - rather than writing a plaintext stub into an encrypted vault.
 */
export async function ensureParentFilesExist(vaultPath: string, absPath: string): Promise<string[]> {
  const relativePath = path.relative(vaultPath, absPath).split(path.sep).join('/');
  const parts = relativePath.split('/');
  if (parts.length <= 1) return [];

  const created: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const parentRel = parts.slice(0, i).join('/') + '.md';
    const parentAbs = path.join(vaultPath, parentRel);
    try {
      const buf = await encodeForVault(vaultPath, Buffer.from('', 'utf-8'));
      await fsp.writeFile(parentAbs, buf, { flag: 'wx' });
      created.push(parentRel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      console.error(`[vaultWriter] Failed to create parent stub ${parentRel}:`, err);
    }
  }
  return created;
}

const fileLocks = new Map<string, Promise<void>>();

function lockKeyFor(absPath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? absPath.toLowerCase() : absPath;
}

/** Serializes concurrent MCP writes to the same file (a read-modify-write race between two stateless requests). Does not protect against a simultaneous GUI save. */
export async function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKeyFor(absPath);
  const previous = fileLocks.get(key) ?? Promise.resolve();

  let releaseNext: () => void = () => {};
  const ourTurnDone = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  fileLocks.set(key, ourTurnDone);

  await previous;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileLocks.get(key) === ourTurnDone) {
      fileLocks.delete(key);
    }
  }
}

function backupPathFor(absPath: string): string {
  const ext = path.extname(absPath);
  const base = absPath.slice(0, absPath.length - ext.length);
  return `${base}.${Date.now()}${ext}.bak`;
}

export interface CreateNoteResult {
  path: string;
  created: boolean;
  overwritten: boolean;
  mode: NoteMode;
  parentsCreated: string[];
  backupPath?: string;
}

export interface CreateNoteOptions {
  mode?: NoteMode;
  overwrite?: boolean;
  expectedGeneration: number;
}

/**
 * Creates a new note. Refuses to clobber an existing one unless
 * `overwrite: true`, in which case the previous raw bytes are always backed
 * up first (not just on shrink, unlike `note:save` - replacing a whole note
 * is the riskiest write this module offers). If `body` already contains its
 * own frontmatter, it's used verbatim (mode must not also be passed);
 * otherwise frontmatter is generated from `mode` (defaulting to freeform).
 */
export async function createNote(
  vaultPath: string,
  relPath: string,
  body: string,
  opts: CreateNoteOptions
): Promise<CreateNoteResult> {
  if (body.length > MAX_CREATE_BODY_CHARS) {
    throw new InvalidArgumentError(`content is too large (max ${MAX_CREATE_BODY_CHARS} characters)`);
  }

  const absPath = await resolveWritableNotePath(vaultPath, relPath);

  const ownFrontmatter = hasOwnFrontmatter(body);
  if (ownFrontmatter && opts.mode !== undefined) {
    throw new InvalidArgumentError('pass mode, or content with its own frontmatter, but not both');
  }
  const mode: NoteMode = ownFrontmatter ? detectNoteMode(body) : (opts.mode ?? 'freeform');
  const doc = ownFrontmatter ? body : buildNewNoteDoc(relPath, body, opts.mode);

  return withFileLock(absPath, async () => {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const parentsCreated = await ensureParentFilesExist(vaultPath, absPath);

    if (!opts.overwrite) {
      const buf = await encodeForVault(vaultPath, Buffer.from(doc, 'utf-8'), {
        expectedGeneration: opts.expectedGeneration
      });
      try {
        await fsp.writeFile(absPath, buf, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new NoteAlreadyExistsError(relPath);
        }
        throw err;
      }
      return { path: relPath, created: true, overwritten: false, mode, parentsCreated };
    }

    let backupPath: string | undefined;
    let wasEncrypted = false;
    try {
      const raw = await fsp.readFile(absPath);
      wasEncrypted = isEncrypted(raw);
      const backupAbs = backupPathFor(absPath);
      await fsp.writeFile(backupAbs, raw);
      backupPath = path.relative(vaultPath, backupAbs).split(path.sep).join('/');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Nothing existed yet - this is really a create, not an overwrite.
    }

    const buf = await encodeForVault(vaultPath, Buffer.from(doc, 'utf-8'), {
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration
    });
    await fsp.writeFile(absPath, buf);

    return {
      path: relPath,
      created: backupPath === undefined,
      overwritten: backupPath !== undefined,
      mode,
      parentsCreated,
      backupPath
    };
  });
}

export interface AppendResult {
  path: string;
  created: boolean;
  mode: NoteMode;
  appended: string;
  parentsCreated: string[];
  /** 1-based line number of the last line of the final document - since `appended` is always the tail, this is also where it ends. A snapshot, like list_tasks' line numbers. */
  endLine: number;
}

export interface AppendToNoteOptions {
  expectedGeneration: number;
  /** If the note doesn't exist, create it with this frontmatter first instead of throwing NoteNotFoundError. */
  createIfMissing?: { frontmatter: string };
}

/**
 * Appends content to the end of an existing note - the only way to modify
 * an existing note's content through this module (append-only by design).
 * Mode is always auto-detected from the note's own frontmatter, never a
 * caller-supplied parameter. Throws `NoteNotFoundError` unless
 * `createIfMissing` is given (used by `add_task`'s default-to-today's-
 * journal case) - an explicitly-named target is never auto-created.
 */
export async function appendToNote(
  vaultPath: string,
  relPath: string,
  addition: string,
  opts: AppendToNoteOptions
): Promise<AppendResult> {
  if (addition.length === 0 || addition.length > MAX_APPEND_CHARS) {
    throw new InvalidArgumentError(`content must be 1-${MAX_APPEND_CHARS} characters`);
  }

  const absPath = await resolveWritableNotePath(vaultPath, relPath);

  return withFileLock(absPath, async () => {
    let raw: Buffer | null = null;
    try {
      raw = await fsp.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    let parentsCreated: string[] = [];
    let created = false;
    let doc: string;
    let wasEncrypted = false;

    if (raw === null) {
      if (!opts.createIfMissing) {
        throw new NoteNotFoundError(relPath);
      }
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      parentsCreated = await ensureParentFilesExist(vaultPath, absPath);
      doc = opts.createIfMissing.frontmatter + '\n';
      created = true;
    } else {
      wasEncrypted = isEncrypted(raw);
      // Decode synchronously right after the read - no `await` in between -
      // so a concurrent lock can't zero the key mid-decrypt.
      const decoded = decodeBuffer(raw, absPath);
      doc = decoded.toString('utf-8');
    }

    const mode = detectNoteMode(doc);
    const { doc: nextDoc, appended } = formatAppend(doc, addition, mode);

    const buf = await encodeForVault(vaultPath, Buffer.from(nextDoc, 'utf-8'), {
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration
    });
    await fsp.writeFile(absPath, buf, created ? { flag: 'wx' } : undefined);

    // nextDoc always ends in exactly one trailing newline, so trimming it
    // before counting gives the 1-based line number of the last real line.
    const endLine = nextDoc.replace(/\n$/, '').split('\n').length;

    return { path: relPath, created, mode, appended, parentsCreated, endLine };
  });
}

export interface InsertUnderBulletResult {
  path: string;
  mode: 'outliner';
  matchedLine: number;
  matchedText: string;
  appended: string;
}

export interface InsertUnderBulletOptions {
  expectedGeneration: number;
  occurrence?: number;
}

/**
 * Inserts `addition` as new children (after any existing ones) of a
 * specific existing bullet in an outliner note, located by a
 * case-insensitive substring match against each bullet's own text - see
 * `noteFormat.insertUnderBullet` for the full matching/placement algorithm.
 * Unlike `appendToNote`, this never creates the target note: it must
 * already exist (throws `NoteNotFoundError` otherwise).
 */
export async function insertUnderBullet(
  vaultPath: string,
  relPath: string,
  matchText: string,
  addition: string,
  opts: InsertUnderBulletOptions
): Promise<InsertUnderBulletResult> {
  const absPath = await resolveWritableNotePath(vaultPath, relPath);

  return withFileLock(absPath, async () => {
    let raw: Buffer;
    try {
      raw = await fsp.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NoteNotFoundError(relPath);
      }
      throw err;
    }

    const wasEncrypted = isEncrypted(raw);
    // Decode synchronously right after the read - no `await` in between -
    // so a concurrent lock can't zero the key mid-decrypt.
    const decoded = decodeBuffer(raw, absPath);
    const doc = decoded.toString('utf-8');

    const result = formatInsertUnderBullet(doc, matchText, addition, {
      occurrence: opts.occurrence
    });

    const buf = await encodeForVault(vaultPath, Buffer.from(result.doc, 'utf-8'), {
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration
    });
    await fsp.writeFile(absPath, buf);

    return {
      path: relPath,
      mode: 'outliner',
      matchedLine: result.matchedLine,
      matchedText: result.matchedText,
      appended: result.appended
    };
  });
}

import { promises as fsp } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';
import { contentHash } from './contentHash';
import { recordSnapshot, recordRename, newOperationId, readVersion } from './noteHistory';
import { rewriteLinks, type LinkRename } from '../shared/linkRewrite';
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
    super(
      'The vault was locked, switched, or closed while this write was in progress; nothing was written'
    );
    this.name = 'VaultStateChangedError';
  }
}

/** Distinct from VaultStateChangedError (vault-level staleness): this is a single addressed line that no longer reads as expected - typically a concurrent edit to that specific task. */
export class LineMismatchError extends Error {
  constructor(
    public readonly relPath: string,
    public readonly line: number
  ) {
    super(
      `Line ${line} in ${relPath} no longer matches the expected text - it may have been edited since it was last read.`
    );
    this.name = 'LineMismatchError';
  }
}

/** The whole-note counterpart of LineMismatchError: the note's content hash no longer matches the `expectedHash` the caller read it with. */
export class NoteChangedError extends Error {
  constructor(public readonly relPath: string) {
    super(
      `${relPath} has changed since it was last read (its hash no longer matches expectedHash). Re-read it and retry.`
    );
    this.name = 'NoteChangedError';
  }
}

/** Asks a write to save the version it replaces to the vault's note history (see noteHistory.ts). */
export interface HistoryOption {
  /** What is making the change, e.g. "edit_note". */
  tool: string;
  /** Short, content-free description of the change. */
  summary?: string;
  /** Groups this entry with the others one operation produced (e.g. the link rewrites of a rename). */
  opId?: string;
}

/**
 * The common tail of every write in this module: encode for the vault,
 * snapshot the bytes being replaced into note history (only when the caller
 * asked for history and there was a previous version), then write
 * atomically. Returns the history version id, if one was recorded.
 */
async function commitWrite(
  vaultPath: string,
  relPath: string,
  absPath: string,
  nextDoc: string,
  o: {
    previousRaw: Buffer | null;
    forceEncrypt?: boolean;
    expectedGeneration: number;
    history?: HistoryOption;
    exclusive?: boolean;
  }
): Promise<string | undefined> {
  const buf = await encodeForVault(vaultPath, Buffer.from(nextDoc, 'utf-8'), {
    forceEncrypt: o.forceEncrypt,
    expectedGeneration: o.expectedGeneration
  });
  let versionId: string | undefined;
  if (o.history && o.previousRaw) {
    const entry = await recordSnapshot(vaultPath, {
      path: relPath,
      raw: o.previousRaw,
      tool: o.history.tool,
      summary: o.history.summary,
      opId: o.history.opId
    });
    versionId = entry.id;
  }
  await writeFileAtomic(absPath, buf, { exclusive: o.exclusive });
  return versionId;
}

/** Throws NoteChangedError if `expectedHash` is given and doesn't match `doc`'s current content hash. */
function checkExpectedHash(relPath: string, doc: string, expectedHash: string | undefined): void {
  if (expectedHash !== undefined && contentHash(doc) !== expectedHash) {
    throw new NoteChangedError(relPath);
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
 * the encryption. The caller must write the result (via `writeFileAtomic`) immediately,
 * with no `await` in between.
 */
export async function encodeForVault(
  vaultPath: string,
  plaintext: Buffer,
  opts: EncodeOptions = {}
): Promise<Buffer> {
  const shouldEncrypt = opts.forceEncrypt || (await vaultState.isEncryptionEnabled(vaultPath));

  // ---- synchronous section: no `await` below until the caller's writeFile ----
  if (
    opts.expectedGeneration !== undefined &&
    vaultState.getGeneration() !== opts.expectedGeneration
  ) {
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
 * `canCreate`, if given, can veto individual stubs (e.g. ones outside an
 * MCP client's permitted folders); vetoed stubs are skipped, not errors.
 */
export async function ensureParentFilesExist(
  vaultPath: string,
  absPath: string,
  canCreate?: (relPath: string) => boolean
): Promise<string[]> {
  const relativePath = path.relative(vaultPath, absPath).split(path.sep).join('/');
  const parts = relativePath.split('/');
  if (parts.length <= 1) return [];

  const created: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const parentRel = parts.slice(0, i).join('/') + '.md';
    const parentAbs = path.join(vaultPath, parentRel);
    if (canCreate && !canCreate(parentRel)) continue;
    try {
      const buf = await encodeForVault(vaultPath, Buffer.from('', 'utf-8'));
      await writeFileAtomic(parentAbs, buf, { exclusive: true });
      created.push(parentRel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      console.error(`[vaultWriter] Failed to create parent stub ${parentRel}:`, err);
    }
  }
  return created;
}

/** The parent stubs ensureParentFilesExist would create for `absPath`, without creating them (for dry runs). */
async function plannedParentStubs(
  vaultPath: string,
  absPath: string,
  canCreate?: (relPath: string) => boolean
): Promise<string[]> {
  const parts = path.relative(vaultPath, absPath).split(path.sep).join('/').split('/');
  const planned: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const parentRel = parts.slice(0, i).join('/') + '.md';
    if (canCreate && !canCreate(parentRel)) continue;
    try {
      await fsp.access(path.join(vaultPath, parentRel));
    } catch {
      planned.push(parentRel);
    }
  }
  return planned;
}

const fileLocks = new Map<string, Promise<void>>();

function lockKeyFor(absPath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? absPath.toLowerCase()
    : absPath;
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
  /** Only for overwrites without `history`: where the replaced version was backed up. */
  backupPath?: string;
  /** Only for overwrites with `history`: the note-history id of the replaced version. */
  versionId?: string;
  /** Content hash of the note as written (see contentHash). */
  hash: string;
  /** True when this was a dry run and nothing was written. */
  dryRun?: boolean;
}

export interface CreateNoteOptions {
  /** Compute and return the result without writing anything (no parent stubs, no history). */
  dryRun?: boolean;
  mode?: NoteMode;
  overwrite?: boolean;
  expectedGeneration: number;
  /** On overwrite, save the replaced version to note history instead of a .bak file beside the note. */
  history?: HistoryOption;
  /** Only meaningful with overwrite: refuse (NoteChangedError) unless the existing note still has this content hash. */
  expectedHash?: string;
  /** Veto for auto-created parent stub notes (see ensureParentFilesExist). */
  canCreateParent?: (relPath: string) => boolean;
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
    throw new InvalidArgumentError(
      `content is too large (max ${MAX_CREATE_BODY_CHARS} characters)`
    );
  }

  const absPath = await resolveWritableNotePath(vaultPath, relPath);

  const ownFrontmatter = hasOwnFrontmatter(body);
  if (ownFrontmatter && opts.mode !== undefined) {
    throw new InvalidArgumentError('pass mode, or content with its own frontmatter, but not both');
  }
  const mode: NoteMode = ownFrontmatter ? detectNoteMode(body) : (opts.mode ?? 'freeform');
  const doc = ownFrontmatter ? body : buildNewNoteDoc(relPath, body, opts.mode);

  return withFileLock(absPath, async () => {
    if (opts.dryRun) {
      let existing: Buffer | null = null;
      try {
        existing = await fsp.readFile(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (existing !== null && !opts.overwrite) throw new NoteAlreadyExistsError(relPath);
      if (existing !== null && opts.expectedHash !== undefined) {
        checkExpectedHash(
          relPath,
          decodeBuffer(existing, absPath).toString('utf-8'),
          opts.expectedHash
        );
      }
      return {
        path: relPath,
        created: existing === null,
        overwritten: existing !== null,
        mode,
        parentsCreated: await plannedParentStubs(vaultPath, absPath, opts.canCreateParent),
        hash: contentHash(doc),
        dryRun: true
      };
    }

    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const parentsCreated = await ensureParentFilesExist(vaultPath, absPath, opts.canCreateParent);

    if (!opts.overwrite) {
      const buf = await encodeForVault(vaultPath, Buffer.from(doc, 'utf-8'), {
        expectedGeneration: opts.expectedGeneration
      });
      try {
        await writeFileAtomic(absPath, buf, { exclusive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new NoteAlreadyExistsError(relPath);
        }
        throw err;
      }
      return {
        path: relPath,
        created: true,
        overwritten: false,
        mode,
        parentsCreated,
        hash: contentHash(doc)
      };
    }

    let previousRaw: Buffer | null = null;
    try {
      previousRaw = await fsp.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Nothing existed yet - this is really a create, not an overwrite.
    }

    let backupPath: string | undefined;
    const wasEncrypted = previousRaw !== null && isEncrypted(previousRaw);
    if (previousRaw !== null) {
      if (opts.expectedHash !== undefined) {
        checkExpectedHash(
          relPath,
          decodeBuffer(previousRaw, absPath).toString('utf-8'),
          opts.expectedHash
        );
      }
      if (!opts.history) {
        const backupAbs = backupPathFor(absPath);
        await writeFileAtomic(backupAbs, previousRaw);
        backupPath = path.relative(vaultPath, backupAbs).split(path.sep).join('/');
      }
    }

    const versionId = await commitWrite(vaultPath, relPath, absPath, doc, {
      previousRaw,
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration,
      history: opts.history
    });

    return {
      path: relPath,
      created: previousRaw === null,
      overwritten: previousRaw !== null,
      mode,
      parentsCreated,
      backupPath,
      versionId,
      hash: contentHash(doc)
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
  /** Content hash of the note as written. */
  hash: string;
  /** Note-history id of the replaced version, when `history` was requested. */
  versionId?: string;
  /** True when this was a dry run and nothing was written. */
  dryRun?: boolean;
}

export interface AppendToNoteOptions {
  /** Compute and return the result without writing anything (no parent stubs, no history). */
  dryRun?: boolean;
  expectedGeneration: number;
  /** Save the version this write replaces to note history. */
  history?: HistoryOption;
  /** If the note doesn't exist, create it with this frontmatter first instead of throwing NoteNotFoundError. */
  createIfMissing?: { frontmatter: string };
  /** Refuse (NoteChangedError) unless the existing note still has this content hash. */
  expectedHash?: string;
  /** Veto for auto-created parent stub notes (see ensureParentFilesExist). */
  canCreateParent?: (relPath: string) => boolean;
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
      if (opts.dryRun) {
        parentsCreated = await plannedParentStubs(vaultPath, absPath, opts.canCreateParent);
      } else {
        await fsp.mkdir(path.dirname(absPath), { recursive: true });
        parentsCreated = await ensureParentFilesExist(vaultPath, absPath, opts.canCreateParent);
      }
      doc = opts.createIfMissing.frontmatter + '\n';
      created = true;
    } else {
      wasEncrypted = isEncrypted(raw);
      // Decode synchronously right after the read - no `await` in between -
      // so a concurrent lock can't zero the key mid-decrypt.
      const decoded = decodeBuffer(raw, absPath);
      doc = decoded.toString('utf-8');
      checkExpectedHash(relPath, doc, opts.expectedHash);
    }

    const mode = detectNoteMode(doc);
    const { doc: nextDoc, appended } = formatAppend(doc, addition, mode);

    // nextDoc always ends in exactly one trailing newline, so trimming it
    // before counting gives the 1-based line number of the last real line.
    const endLine = nextDoc.replace(/\n$/, '').split('\n').length;

    if (opts.dryRun) {
      return {
        path: relPath,
        created,
        mode,
        appended,
        parentsCreated,
        endLine,
        hash: contentHash(nextDoc),
        dryRun: true
      };
    }

    const versionId = await commitWrite(vaultPath, relPath, absPath, nextDoc, {
      previousRaw: raw,
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration,
      history: opts.history,
      exclusive: created
    });

    return {
      path: relPath,
      created,
      mode,
      appended,
      parentsCreated,
      endLine,
      hash: contentHash(nextDoc),
      versionId
    };
  });
}

export interface ReplaceLinesResult {
  path: string;
  line: number;
  /** newLines.length - 1: positive when the replacement grew the file (e.g. a recurring task's completion inserting a next-occurrence line), negative if it shrank it. */
  linesAdded: number;
  /** Content hash of the note as written. */
  hash: string;
  /** Note-history id of the replaced version, when `history` was requested. */
  versionId?: string;
  /** True when this was a dry run and nothing was written. */
  dryRun?: boolean;
}

export interface ReplaceLinesOptions {
  /** Compute and return the result without writing anything (no parent stubs, no history). */
  dryRun?: boolean;
  expectedGeneration: number;
  /** Save the version this write replaces to note history. */
  history?: HistoryOption;
}

/**
 * Replaces a single line (1-based line number) with one or more new lines,
 * after verifying the line's current exact text matches `expectedText`
 * (optimistic concurrency - throws `LineMismatchError` otherwise). This is
 * the one generalization of append/insert-only editing this module offers
 * for an in-place edit; used for task status/metadata writes that
 * originate outside the currently-open editor buffer (e.g. inline
 * quick-edit from a Tasks list, or an MCP `complete_task`/`update_task`
 * call), where the caller only has a stale-by-nature (file, line, text)
 * triple rather than a live document to splice directly.
 */
export async function replaceLines(
  vaultPath: string,
  relPath: string,
  target: { line: number; expectedText: string },
  newLines: string[],
  opts: ReplaceLinesOptions
): Promise<ReplaceLinesResult> {
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
    const lines = doc.split('\n');

    const idx = target.line - 1;
    if (idx < 0 || idx >= lines.length || lines[idx] !== target.expectedText) {
      throw new LineMismatchError(relPath, target.line);
    }

    const nextLines = [...lines.slice(0, idx), ...newLines, ...lines.slice(idx + 1)];
    const nextDoc = nextLines.join('\n');

    if (opts.dryRun) {
      return {
        path: relPath,
        line: target.line,
        linesAdded: newLines.length - 1,
        hash: contentHash(nextDoc),
        dryRun: true
      };
    }

    const versionId = await commitWrite(vaultPath, relPath, absPath, nextDoc, {
      previousRaw: raw,
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration,
      history: opts.history
    });

    return {
      path: relPath,
      line: target.line,
      linesAdded: newLines.length - 1,
      hash: contentHash(nextDoc),
      versionId
    };
  });
}

export interface InsertUnderBulletResult {
  path: string;
  mode: 'outliner';
  matchedLine: number;
  matchedText: string;
  appended: string;
  /** Content hash of the note as written. */
  hash: string;
  /** Note-history id of the replaced version, when `history` was requested. */
  versionId?: string;
  /** True when this was a dry run and nothing was written. */
  dryRun?: boolean;
}

export interface InsertUnderBulletOptions {
  /** Compute and return the result without writing anything (no parent stubs, no history). */
  dryRun?: boolean;
  expectedGeneration: number;
  /** Save the version this write replaces to note history. */
  history?: HistoryOption;
  occurrence?: number;
  /** Refuse (NoteChangedError) unless the note still has this content hash. */
  expectedHash?: string;
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
    checkExpectedHash(relPath, doc, opts.expectedHash);

    const result = formatInsertUnderBullet(doc, matchText, addition, {
      occurrence: opts.occurrence
    });

    if (opts.dryRun) {
      return {
        path: relPath,
        mode: 'outliner',
        matchedLine: result.matchedLine,
        matchedText: result.matchedText,
        appended: result.appended,
        hash: contentHash(result.doc),
        dryRun: true
      };
    }

    const versionId = await commitWrite(vaultPath, relPath, absPath, result.doc, {
      previousRaw: raw,
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration,
      history: opts.history
    });

    return {
      path: relPath,
      mode: 'outliner',
      matchedLine: result.matchedLine,
      matchedText: result.matchedText,
      appended: result.appended,
      hash: contentHash(result.doc),
      versionId
    };
  });
}

export interface RestoreVersionResult {
  path: string;
  /** The history id that was restored. */
  restoredFrom: string;
  /** History id of the version the restore replaced (so the restore itself can be undone). */
  versionId?: string;
  /** True if the note no longer existed and the restore recreated it. */
  created: boolean;
  hash: string;
  /** True when this was a dry run and nothing was written. */
  dryRun?: boolean;
}

export interface RestoreVersionOptions {
  /** Compute and return the result without writing anything (no parent stubs, no history). */
  dryRun?: boolean;
  expectedGeneration: number;
  /** Refuse (NoteChangedError) unless the note's current content still has this hash. */
  expectedHash?: string;
  history?: HistoryOption;
  /** Called with the version's note path before anything is written - e.g. to enforce an MCP write scope. */
  beforeWrite?: (relPath: string) => Promise<void>;
}

/**
 * Restores a note to a version saved in note history. The snapshot is
 * decoded and re-encoded for the vault's current state rather than written
 * back byte-for-byte, so a version saved before encryption was turned on is
 * never restored as plaintext into a now-encrypted vault. The version being
 * replaced is itself saved to history (when `history` is given), so a
 * restore can be undone the same way.
 */
export async function restoreVersion(
  vaultPath: string,
  id: string,
  opts: RestoreVersionOptions
): Promise<RestoreVersionResult> {
  const { entry, raw: snapshotRaw } = await readVersion(vaultPath, id);
  if (entry.kind === 'rename') {
    // Undoing a rename means moving the note back (and its links with it), which
    // needs the link candidates only the caller has - see renameNote.
    throw new InvalidArgumentError(
      `version ${id} records a rename, not content; revert it by renaming the note back`
    );
  }
  await opts.beforeWrite?.(entry.path);
  const absPath = await resolveWritableNotePath(vaultPath, entry.path);

  return withFileLock(absPath, async () => {
    let currentRaw: Buffer | null = null;
    try {
      currentRaw = await fsp.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (currentRaw !== null) {
      checkExpectedHash(
        entry.path,
        decodeBuffer(currentRaw, absPath).toString('utf-8'),
        opts.expectedHash
      );
    } else if (!opts.dryRun) {
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
    }

    const restoredDoc = decodeBuffer(snapshotRaw, absPath).toString('utf-8');
    if (opts.dryRun) {
      return {
        path: entry.path,
        restoredFrom: id,
        created: currentRaw === null,
        hash: contentHash(restoredDoc),
        dryRun: true
      };
    }
    const versionId = await commitWrite(vaultPath, entry.path, absPath, restoredDoc, {
      previousRaw: currentRaw,
      forceEncrypt: isEncrypted(snapshotRaw) || (currentRaw !== null && isEncrypted(currentRaw)),
      expectedGeneration: opts.expectedGeneration,
      history: opts.history,
      exclusive: currentRaw === null
    });

    return {
      path: entry.path,
      restoredFrom: id,
      versionId,
      created: currentRaw === null,
      hash: contentHash(restoredDoc)
    };
  });
}

/** Upper bound on a note's size after an in-place edit. */
const MAX_NOTE_CHARS = 500_000;

export interface ModifyNoteOptions {
  expectedGeneration: number;
  /** Refuse (NoteChangedError) unless the note still has this content hash. */
  expectedHash?: string;
  /** Compute and return the result without writing anything. */
  dryRun?: boolean;
  history?: HistoryOption;
}

export interface ModifyNoteResult<M> {
  path: string;
  /** Hash of the resulting content (of what would be written, for a dry run). */
  hash: string;
  /** False if the transform left the note exactly as it was (nothing is written then). */
  changed: boolean;
  dryRun: boolean;
  versionId?: string;
  /** Whatever the transform reported about what it did. */
  meta: M;
}

/**
 * The general in-place edit: reads an existing note, verifies `expectedHash`,
 * runs `transform` on its decrypted text, and - unless this is a dry run or
 * nothing changed - commits the result through the same encode/history/
 * atomic-write path as every other write. `transform` should throw to refuse
 * an edit; nothing is written in that case.
 */
export async function modifyNote<M>(
  vaultPath: string,
  relPath: string,
  transform: (doc: string) => { doc: string; meta: M },
  opts: ModifyNoteOptions
): Promise<ModifyNoteResult<M>> {
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
    const doc = decodeBuffer(raw, absPath).toString('utf-8');
    checkExpectedHash(relPath, doc, opts.expectedHash);

    const { doc: nextDoc, meta } = transform(doc);
    if (nextDoc.length > MAX_NOTE_CHARS) {
      throw new InvalidArgumentError(
        `the edited note would be too large (max ${MAX_NOTE_CHARS} characters)`
      );
    }

    const changed = nextDoc !== doc;
    const base = { path: relPath, hash: contentHash(nextDoc), changed, meta };
    if (opts.dryRun || !changed) {
      return { ...base, dryRun: opts.dryRun === true };
    }

    const versionId = await commitWrite(vaultPath, relPath, absPath, nextDoc, {
      previousRaw: raw,
      forceEncrypt: wasEncrypted,
      expectedGeneration: opts.expectedGeneration,
      history: opts.history
    });
    return { ...base, dryRun: false, versionId };
  });
}

export class HasChildNotesError extends Error {
  constructor(
    public readonly relPath: string,
    public readonly children: string[]
  ) {
    super(
      `${relPath} has child notes (${children.slice(0, 5).join(', ')}${children.length > 5 ? ', ...' : ''}). ` +
        'Pass includeChildren to move them together with it, or move the children first.'
    );
    this.name = 'HasChildNotesError';
  }
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fsp.lstat(absPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** True if both paths name the same file on disk (e.g. a case-only rename on a case-insensitive filesystem). */
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fsp.lstat(a), fsp.lstat(b)]);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** Vault-relative paths of the .md notes under `dirAbs` (skipping hidden folders/files). */
async function listNotesUnder(vaultPath: string, dirAbs: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(dirAbs, { recursive: true })) as string[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .map((e) => e.split(path.sep).join('/'))
    .filter(
      (e) => e.toLowerCase().endsWith('.md') && !e.split('/').some((seg) => seg.startsWith('.'))
    )
    .map((e) => path.relative(vaultPath, path.join(dirAbs, e)).split(path.sep).join('/'))
    .sort();
}

export interface RenameNoteOptions {
  expectedGeneration: number;
  /**
   * Notes that may contain links to the note(s) being moved - e.g. their
   * backlinks from the link graph. A function receives every path being moved
   * (the note plus, with includeChildren, its child notes).
   */
  linkCandidates: string[] | ((movedPaths: string[]) => string[]);
  /** Move the note's child notes (the same-named folder) along with it, and update links to them. */
  includeChildren?: boolean;
  /** Move only the note, leaving its child notes where they are (the app's long-standing behavior). */
  leaveChildren?: boolean;
  /** Refuse (NoteChangedError) unless the note being moved still has this content hash. */
  expectedHash?: string;
  dryRun?: boolean;
  /** Record the rename (and each link rewrite, grouped under one opId) in note history. */
  history?: HistoryOption;
  /**
   * Called with every vault-relative path the operation will move, create, or
   * rewrite - before anything is changed. Throw to veto (e.g. an MCP write
   * scope or unsaved-edits check). `role` says why the path is involved.
   */
  beforeWrite?: (relPath: string, role: 'source' | 'destination' | 'link') => Promise<void>;
  canCreateParent?: (relPath: string) => boolean;
}

export interface RenameNoteResult {
  from: string;
  to: string;
  /** Child notes moved with it, as [oldPath, newPath] pairs. */
  movedChildren: Array<[string, string]>;
  /** Notes whose links were rewritten (paths after the move), with how many links each. */
  linksUpdated: Array<{ path: string; links: number }>;
  /** Notes whose links could not be rewritten (the move itself still happened). */
  linksFailed: Array<{ path: string; error: string }>;
  parentsCreated: string[];
  /** History id of the rename entry, when history was requested. */
  versionId?: string;
  dryRun?: boolean;
}

/**
 * Renames or moves a note (and, with `includeChildren`, its child notes) and
 * rewrites links to it across the vault - the one implementation behind both
 * the app's Rename/Move and MCP's move_note.
 *
 * Everything is checked before anything changes: the source exists, the
 * destination is free (never overwritten), child notes are handled, and every
 * note whose links will change has been read and decrypted and passed
 * `beforeWrite`. Then the file (and folder) is renamed atomically, and each
 * link rewrite goes through the same atomic, history-recording write path as
 * every other edit. A link rewrite that fails at that point is reported in
 * `linksFailed` rather than undoing the move.
 */
export async function renameNote(
  vaultPath: string,
  from: string,
  to: string,
  opts: RenameNoteOptions
): Promise<RenameNoteResult> {
  if (from === to) throw new InvalidArgumentError('the new path is the same as the current one');
  const fromAbs = await resolveWritableNotePath(vaultPath, from);
  const toAbs = await resolveWritableNotePath(vaultPath, to);

  if (!(await pathExists(fromAbs))) throw new NoteNotFoundError(from);
  if ((await pathExists(toAbs)) && !(await isSameFile(fromAbs, toAbs))) {
    throw new NoteAlreadyExistsError(to);
  }

  // Child notes live in the folder named after the note: People.md -> People/.
  const fromDirRel = from.replace(/\.md$/i, '');
  const toDirRel = to.replace(/\.md$/i, '');
  const fromDirAbs = fromAbs.replace(/\.md$/i, '');
  const toDirAbs = toAbs.replace(/\.md$/i, '');
  const children = await listNotesUnder(vaultPath, fromDirAbs);
  const includeChildren = opts.includeChildren === true;
  if (includeChildren && opts.leaveChildren) {
    throw new InvalidArgumentError('pass includeChildren or leaveChildren, not both');
  }
  if (children.length > 0 && !includeChildren && !opts.leaveChildren) {
    throw new HasChildNotesError(from, children);
  }
  const movesFolder = includeChildren && (await pathExists(fromDirAbs));
  if (movesFolder) {
    if (toDirRel === fromDirRel || to.startsWith(fromDirRel + '/')) {
      throw new InvalidArgumentError("a note can't be moved into its own child folder");
    }
    if ((await pathExists(toDirAbs)) && !(await isSameFile(fromDirAbs, toDirAbs))) {
      throw new NoteAlreadyExistsError(toDirRel + '/');
    }
  }

  const mapPath = (rel: string): string => {
    if (rel === from) return to;
    if (movesFolder && rel.startsWith(fromDirRel + '/'))
      return toDirRel + rel.slice(fromDirRel.length);
    return rel;
  };
  const movedChildren: Array<[string, string]> = movesFolder
    ? children.map((c) => [c, mapPath(c)])
    : [];
  const renames: LinkRename[] = [{ from, to, prefix: movesFolder }];

  await opts.beforeWrite?.(from, 'source');
  await opts.beforeWrite?.(to, 'destination');
  for (const [oldPath, newPath] of movedChildren) {
    await opts.beforeWrite?.(oldPath, 'source');
    await opts.beforeWrite?.(newPath, 'destination');
  }

  if (opts.expectedHash !== undefined) {
    const raw = await fsp.readFile(fromAbs);
    checkExpectedHash(from, decodeBuffer(raw, fromAbs).toString('utf-8'), opts.expectedHash);
  }

  // Plan the link rewrites: the candidates, plus the moved notes themselves
  // (they can link to each other). Reading/decrypting everything now means a
  // locked vault or unreadable note stops the operation before anything moves.
  const movedPaths = [from, ...movedChildren.map(([c]) => c)];
  const extraCandidates =
    typeof opts.linkCandidates === 'function'
      ? opts.linkCandidates(movedPaths)
      : opts.linkCandidates;
  const candidates = [...new Set([...extraCandidates, ...movedPaths])];
  const planned: Array<{ oldPath: string; finalPath: string; links: number }> = [];
  for (const rel of candidates) {
    let abs: string;
    try {
      abs = await resolveWritableNotePath(vaultPath, rel);
    } catch {
      continue; // not a writable note path (e.g. a virtual graph node)
    }
    let raw: Buffer;
    try {
      raw = await fsp.readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const { linksChanged } = rewriteLinks(decodeBuffer(raw, abs).toString('utf-8'), renames);
    if (linksChanged === 0) continue;
    const finalPath = mapPath(rel);
    if (rel !== from && !movedChildren.some(([c]) => c === rel)) {
      await opts.beforeWrite?.(rel, 'link');
    }
    planned.push({ oldPath: rel, finalPath, links: linksChanged });
  }

  if (opts.dryRun) {
    return {
      from,
      to,
      movedChildren,
      linksUpdated: planned.map((p) => ({ path: p.finalPath, links: p.links })),
      linksFailed: [],
      parentsCreated: await plannedParentStubs(vaultPath, toAbs, opts.canCreateParent),
      dryRun: true
    };
  }

  if (vaultState.getGeneration() !== opts.expectedGeneration) throw new VaultStateChangedError();

  const parentsCreated = await withFileLock(fromAbs, async () => {
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });
    const stubs = await ensureParentFilesExist(vaultPath, toAbs, opts.canCreateParent);
    await fsp.rename(fromAbs, toAbs);
    if (movesFolder) {
      await fsp.mkdir(path.dirname(toDirAbs), { recursive: true });
      await fsp.rename(fromDirAbs, toDirAbs);
    }
    return stubs;
  });

  const opId = opts.history ? newOperationId() : undefined;
  let versionId: string | undefined;
  if (opts.history) {
    const entry = await recordRename(vaultPath, {
      from,
      to,
      includeChildren: movesFolder,
      tool: opts.history.tool,
      summary:
        planned.length > 0
          ? `links updated in ${planned.length} note${planned.length === 1 ? '' : 's'}`
          : opts.history.summary,
      opId
    });
    versionId = entry.id;
  }

  const linksUpdated: RenameNoteResult['linksUpdated'] = [];
  const linksFailed: RenameNoteResult['linksFailed'] = [];
  for (const p of planned) {
    try {
      const abs = await resolveWritableNotePath(vaultPath, p.finalPath);
      await withFileLock(abs, async () => {
        // Re-read: the note may have changed since planning; rewrite what's there now.
        const raw = await fsp.readFile(abs);
        const doc = decodeBuffer(raw, abs).toString('utf-8');
        const rewritten = rewriteLinks(doc, renames);
        if (rewritten.linksChanged === 0) return;
        await commitWrite(vaultPath, p.finalPath, abs, rewritten.doc, {
          previousRaw: raw,
          forceEncrypt: isEncrypted(raw),
          expectedGeneration: opts.expectedGeneration,
          history: opts.history && {
            tool: opts.history.tool,
            summary: `links to ${to}`,
            opId
          }
        });
        linksUpdated.push({ path: p.finalPath, links: rewritten.linksChanged });
      });
    } catch (err) {
      linksFailed.push({
        path: p.finalPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { from, to, movedChildren, linksUpdated, linksFailed, parentsCreated, versionId };
}

export interface DeleteNoteOptions {
  expectedGeneration: number;
  /** Refuse (NoteChangedError) unless the note still has this content hash. */
  expectedHash?: string;
  dryRun?: boolean;
  /** Save the note's content to note history (as a 'delete' entry) before deleting it. */
  history?: HistoryOption;
  /** Removes the file - e.g. moving it to the OS trash. Defaults to unlinking it. */
  trash?: (absPath: string) => Promise<void>;
}

export interface DeleteNoteResult {
  path: string;
  /** History id of the saved content, when history was requested. */
  versionId?: string;
  dryRun?: boolean;
}

/**
 * Deletes a note: saves its exact bytes to note history first (when asked),
 * so restore_note_version / Revert can recreate it, then removes the file
 * via `trash`. Child notes are not touched.
 */
export async function deleteNote(
  vaultPath: string,
  relPath: string,
  opts: DeleteNoteOptions
): Promise<DeleteNoteResult> {
  const absPath = await resolveWritableNotePath(vaultPath, relPath);
  return withFileLock(absPath, async () => {
    let raw: Buffer;
    try {
      raw = await fsp.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NoteNotFoundError(relPath);
      throw err;
    }
    if (opts.expectedHash !== undefined) {
      checkExpectedHash(relPath, decodeBuffer(raw, absPath).toString('utf-8'), opts.expectedHash);
    }
    if (opts.dryRun) return { path: relPath, dryRun: true };
    if (vaultState.getGeneration() !== opts.expectedGeneration) throw new VaultStateChangedError();

    let versionId: string | undefined;
    if (opts.history) {
      const entry = await recordSnapshot(vaultPath, {
        path: relPath,
        raw,
        tool: opts.history.tool,
        summary: opts.history.summary,
        kind: 'delete',
        opId: opts.history.opId
      });
      versionId = entry.id;
    }
    await (opts.trash ?? ((p: string) => fsp.unlink(p)))(absPath);
    return { path: relPath, versionId };
  });
}

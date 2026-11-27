import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpDeps, WriteCtx } from './deps';
import { auditLog } from './audit';
import { assertNoRedactionMasks, redactText, redactValue } from './redact';

/** Every string anywhere inside a tool's arguments (nested objects/arrays included). */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((v) => collectStrings(v, out));
  }
  return out;
}

/** All tool output passes through here (or `toErrorResult`), so PII is masked before it leaves the app. */
export function toCallToolResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  const redacted = redactValue(data);
  return {
    content: [{ type: 'text', text: JSON.stringify(redacted) }],
    structuredContent: redacted
  };
}

export class IndexNotReadyError extends Error {
  constructor() {
    super(
      'The search/graph/task index is not ready yet (still building after unlock or vault open). Try again shortly.'
    );
    this.name = 'IndexNotReadyError';
  }
}

export function toErrorResult(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: redactText(`${code}: ${message}`) }],
    isError: true
  };
}

/** Maps the vaultReader/vaultPaths/vaultWriter typed errors (matched by name, to avoid a hard import) to a stable code. */
function errorCodeFor(err: unknown): string {
  if (err instanceof Error) {
    switch (err.name) {
      case 'VaultNotOpenError':
        return 'VAULT_NOT_OPEN';
      case 'VaultLockedError':
        return 'VAULT_LOCKED';
      case 'DecryptError':
        return 'DECRYPT_FAILED';
      case 'NoteNotFoundError':
        return 'NOTE_NOT_FOUND';
      case 'PathNotAllowedError':
        return 'PATH_NOT_ALLOWED';
      case 'IndexNotReadyError':
        return 'INDEX_NOT_READY';
      case 'NoteAlreadyExistsError':
        return 'NOTE_ALREADY_EXISTS';
      case 'VaultStateChangedError':
        return 'VAULT_STATE_CHANGED';
      case 'InvalidArgumentError':
        return 'INVALID_ARGUMENT';
      case 'NotOutlinerModeError':
        return 'NOT_OUTLINER_MODE';
      case 'BulletNotFoundError':
        return 'BULLET_NOT_FOUND';
      case 'AmbiguousMatchError':
        return 'AMBIGUOUS_MATCH';
      case 'LineMismatchError':
        return 'LINE_MISMATCH';
      case 'NoteChangedError':
        return 'NOTE_CHANGED';
      case 'RedactedContentError':
        return 'REDACTED_CONTENT';
      case 'PathNotInWriteScopeError':
        return 'PATH_NOT_IN_WRITE_SCOPE';
      case 'NoteHasUnsavedEditsError':
        return 'NOTE_HAS_UNSAVED_EDITS';
      case 'VersionNotFoundError':
        return 'VERSION_NOT_FOUND';
      default:
        return 'INTERNAL_ERROR';
    }
  }
  return 'INTERNAL_ERROR';
}

/**
 * Wraps a tool handler so it: (1) refuses to run at all unless the vault is
 * currently open and unlocked, (2) re-checks the vault "generation" after
 * the handler completes, so a lock/switch/close that happened mid-request
 * invalidates the result rather than returning data read before it, and (3)
 * records every call (success or failure) in the in-memory audit log.
 * `get_vault_status` is the one tool that intentionally does not use this
 * wrapper, since it must keep working when the vault is locked or closed.
 */
export function withVaultGuard<Args extends unknown[], T extends Record<string, unknown>>(
  toolName: string,
  deps: Pick<McpDeps, 'isReadable' | 'getGeneration'>,
  handler: (...args: Args) => Promise<T>
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    const record = (ok: boolean, errorCode?: string): void =>
      auditLog.record({ ts: new Date().toISOString(), tool: toolName, ok, errorCode });

    if (!(await deps.isReadable())) {
      record(false, 'VAULT_LOCKED');
      return toErrorResult(
        'VAULT_LOCKED',
        'The vault is locked or not open. Ask the user to open or unlock it in the Phosphor Notes app - there is no tool to unlock it remotely.'
      );
    }
    const generation = deps.getGeneration();
    try {
      const result = await handler(...args);
      if (deps.getGeneration() !== generation) {
        record(false, 'VAULT_STATE_CHANGED');
        return toErrorResult(
          'VAULT_STATE_CHANGED',
          'The vault was locked, switched, or closed while this request was in progress. Retry the request.'
        );
      }
      record(true);
      return toCallToolResult(result);
    } catch (err) {
      const code = errorCodeFor(err);
      record(false, code);
      return toErrorResult(code, err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * The write-tool counterpart of `withVaultGuard`: additionally requires
 * `isWriteEnabled()`, and hands the handler a `{generation}` context to
 * pass down into `vaultWriter`'s own pre-write generation check (inside its
 * synchronous encode step) - unlike the read-side guard, there is
 * deliberately **no post-handler generation re-check** here. Once bytes are
 * on disk the write happened; reporting `VAULT_STATE_CHANGED` for a write
 * that already succeeded would just cause the caller to retry and
 * duplicate the change. `targetOf` extracts the vault-relative path (if
 * any) from the tool's arguments, recorded in the audit log.
 */
export function withVaultWriteGuard<TArgs, T extends Record<string, unknown>>(
  toolName: string,
  deps: Pick<McpDeps, 'isReadable' | 'getGeneration' | 'isWriteEnabled' | 'isEditEnabled'>,
  handler: (args: TArgs, ctx: WriteCtx) => Promise<T>,
  targetOf?: (args: TArgs) => string | undefined,
  opts: { tier?: 'write' | 'edit' } = {}
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs) => {
    const record = (ok: boolean, errorCode?: string, versionId?: string): void =>
      auditLog.record({
        ts: new Date().toISOString(),
        tool: toolName,
        ok,
        errorCode,
        target: targetOf?.(args),
        write: true,
        versionId
      });

    if (!deps.isWriteEnabled()) {
      record(false, 'WRITE_DISABLED');
      return toErrorResult(
        'WRITE_DISABLED',
        "Write access is turned off. Ask the user to enable it in Phosphor Notes' Settings > AI Access."
      );
    }
    if (opts.tier === 'edit' && !deps.isEditEnabled()) {
      record(false, 'EDIT_DISABLED');
      return toErrorResult(
        'EDIT_DISABLED',
        "Editing existing text is turned off. Ask the user to enable it in Phosphor Notes' Settings > AI Access."
      );
    }
    if (!(await deps.isReadable())) {
      record(false, 'VAULT_LOCKED');
      return toErrorResult(
        'VAULT_LOCKED',
        'The vault is locked or not open. Ask the user to open or unlock it in the Phosphor Notes app - there is no tool to unlock it remotely.'
      );
    }
    const generation = deps.getGeneration();
    try {
      // Every string argument of every write tool: none may carry a redaction
      // placeholder copied from a read (see assertNoRedactionMasks).
      assertNoRedactionMasks(...collectStrings(args));
      const result = await handler(args, { generation, tool: toolName });
      const versionId = (result as { versionId?: unknown }).versionId;
      record(true, undefined, typeof versionId === 'string' ? versionId : undefined);
      return toCallToolResult(result);
    } catch (err) {
      const code = errorCodeFor(err);
      record(false, code);
      return toErrorResult(code, err instanceof Error ? err.message : String(err));
    }
  };
}

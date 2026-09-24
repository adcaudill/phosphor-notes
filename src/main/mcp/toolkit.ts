import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpDeps } from './deps';
import { auditLog } from './audit';

export function toCallToolResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
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
    content: [{ type: 'text', text: `${code}: ${message}` }],
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
  deps: Pick<McpDeps, 'isReadable' | 'getGeneration' | 'isWriteEnabled'>,
  handler: (args: TArgs, ctx: { generation: number }) => Promise<T>,
  targetOf?: (args: TArgs) => string | undefined
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs) => {
    const record = (ok: boolean, errorCode?: string): void =>
      auditLog.record({
        ts: new Date().toISOString(),
        tool: toolName,
        ok,
        errorCode,
        target: targetOf?.(args),
        write: true
      });

    if (!deps.isWriteEnabled()) {
      record(false, 'WRITE_DISABLED');
      return toErrorResult(
        'WRITE_DISABLED',
        "Write access is turned off. Ask the user to enable it in Phosphor Notes' Settings > AI Access."
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
      const result = await handler(args, { generation });
      record(true);
      return toCallToolResult(result);
    } catch (err) {
      const code = errorCodeFor(err);
      record(false, code);
      return toErrorResult(code, err instanceof Error ? err.message : String(err));
    }
  };
}

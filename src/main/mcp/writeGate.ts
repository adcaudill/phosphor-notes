import { assertInWriteScope, isInWriteScope, type WriteScope } from './scope';

export class NoteHasUnsavedEditsError extends Error {
  constructor(public readonly relPath: string) {
    super(
      `${relPath} is open in Phosphor Notes with unsaved edits. Ask the user to save it (or wait a ` +
        'moment for autosave) and then retry, so this change does not conflict with theirs.'
    );
    this.name = 'NoteHasUnsavedEditsError';
  }
}

export interface WriteGateOptions {
  getWriteScope: () => WriteScope;
  /** Whether `relPath` is open in the app's editor with unsaved changes. Optional: no check when absent. */
  isNoteDirty?: (relPath: string) => Promise<boolean>;
}

/**
 * The single place every MCP write passes through before touching disk:
 * enforces the user's folder scope and refuses to write under unsaved edits
 * open in the app. Shared by the real deps and the integration tests' fake
 * deps so both exercise exactly the same rules.
 */
export interface WriteGate {
  /** Throws PathNotInWriteScopeError or NoteHasUnsavedEditsError if `relPath` may not be written right now. */
  check(relPath: string): Promise<void>;
  /** Filter for auto-created parent stub notes: stubs outside the write scope are skipped, not created. */
  canCreateParent(relPath: string): boolean;
}

export function createWriteGate(opts: WriteGateOptions): WriteGate {
  return {
    async check(relPath: string): Promise<void> {
      assertInWriteScope(relPath, opts.getWriteScope());
      if (opts.isNoteDirty && (await opts.isNoteDirty(relPath))) {
        throw new NoteHasUnsavedEditsError(relPath);
      }
    },
    canCreateParent(relPath: string): boolean {
      return isInWriteScope(relPath, opts.getWriteScope());
    }
  };
}

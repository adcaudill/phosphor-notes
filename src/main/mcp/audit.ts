const MAX_ENTRIES = 200;

export interface AuditEntry {
  ts: string; // ISO timestamp
  tool: string;
  /** Non-sensitive summary of the call's arguments (e.g. a note path or search query), never full note content. */
  argsSummary?: string;
  ok: boolean;
  errorCode?: string;
  /** The vault-relative path affected, for write-tool calls only. */
  target?: string;
  /** True for a create/append/add-task style call. */
  write?: boolean;
}

/** In-memory-only ring buffer of recent MCP tool calls, surfaced in Settings. Never written to disk. */
class AuditLog {
  private entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  recent(limit = MAX_ENTRIES): AuditEntry[] {
    return this.entries.slice(-limit);
  }

  clear(): void {
    this.entries = [];
  }
}

export const auditLog = new AuditLog();

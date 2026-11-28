import { promises as fsp } from 'fs';
import * as path from 'path';
import { normalizeFolderList } from './scope';

export const DEFAULT_PORT = 47823;

export interface McpConfig {
  enabled: boolean;
  port: number;
  /** SHA-256 hex digest of the current bearer token. The plaintext token is never persisted. */
  tokenHash: string | null;
  tokenCreatedAt: string | null;
  /** A second, separate opt-in from `enabled` - write tools aren't registered at all unless this is also true. */
  writeEnabled: boolean;
  /**
   * A third opt-in, on top of `writeEnabled`: tools that edit or remove existing
   * text in place (edit_note, section tools, update_frontmatter,
   * restore_note_version) are registered only when this is also true.
   */
  editEnabled: boolean;
  /** On top of editEnabled: move_note (rename/move notes, rewriting links to them). */
  organizeEnabled: boolean;
  /** On top of editEnabled: delete_note. */
  deleteEnabled: boolean;
  /**
   * Whether AI apps may change task files (create, complete, update, ...),
   * given write access. Tasks belong to no folder, so the folder scope below
   * can't cover them; this is their own switch. On by default.
   */
  tasksEnabled: boolean;
  /** Folders MCP writes are limited to; empty means the whole vault. */
  writeAllowFolders: string[];
  /** Folders MCP writes may never touch; wins over writeAllowFolders. */
  writeDenyFolders: string[];
}

const DEFAULTS: McpConfig = {
  enabled: false,
  port: DEFAULT_PORT,
  tokenHash: null,
  tokenCreatedAt: null,
  writeEnabled: false,
  editEnabled: false,
  organizeEnabled: false,
  deleteEnabled: false,
  tasksEnabled: true,
  writeAllowFolders: [],
  writeDenyFolders: []
};

export function getConfigPath(userDataDir: string): string {
  return path.join(userDataDir, '.phosphor', 'mcp.json');
}

export async function loadConfig(userDataDir: string): Promise<McpConfig> {
  try {
    const raw = await fsp.readFile(getConfigPath(userDataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    const writeEnabled = parsed.writeEnabled === true;
    // Edit access is meaningless (and never honored) without write access.
    const editEnabled = writeEnabled && parsed.editEnabled === true;
    return {
      ...DEFAULTS,
      ...parsed,
      writeEnabled,
      editEnabled,
      // Organize and delete build on edit access, and are never honored without it.
      organizeEnabled: editEnabled && parsed.organizeEnabled === true,
      deleteEnabled: editEnabled && parsed.deleteEnabled === true,
      tasksEnabled: parsed.tasksEnabled !== false,
      writeAllowFolders: normalizeFolderList(parsed.writeAllowFolders),
      writeDenyFolders: normalizeFolderList(parsed.writeDenyFolders)
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(userDataDir: string, config: McpConfig): Promise<void> {
  const configPath = getConfigPath(userDataDir);
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fsp.rename(tmpPath, configPath);
  try {
    await fsp.chmod(configPath, 0o600);
  } catch {
    // Best-effort; not all platforms/filesystems support chmod semantics.
  }
}

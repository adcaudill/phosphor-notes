import { promises as fsp } from 'fs';
import * as path from 'path';

export const DEFAULT_PORT = 47823;

export interface McpConfig {
  enabled: boolean;
  port: number;
  /** SHA-256 hex digest of the current bearer token. The plaintext token is never persisted. */
  tokenHash: string | null;
  tokenCreatedAt: string | null;
  /** A second, separate opt-in from `enabled` - write tools aren't registered at all unless this is also true. */
  writeEnabled: boolean;
}

const DEFAULTS: McpConfig = {
  enabled: false,
  port: DEFAULT_PORT,
  tokenHash: null,
  tokenCreatedAt: null,
  writeEnabled: false
};

export function getConfigPath(userDataDir: string): string {
  return path.join(userDataDir, '.phosphor', 'mcp.json');
}

export async function loadConfig(userDataDir: string): Promise<McpConfig> {
  try {
    const raw = await fsp.readFile(getConfigPath(userDataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    return { ...DEFAULTS, ...parsed, writeEnabled: parsed.writeEnabled === true };
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

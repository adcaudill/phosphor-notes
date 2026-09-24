import * as http from 'http';
import type { BrowserWindow } from 'electron';
import * as vaultState from '../vaultState';
import { loadConfig, saveConfig, DEFAULT_PORT, type McpConfig } from './config';
import { generateToken, hashToken } from './auth';
import { createRequestListener } from './httpServer';
import { createPhosphorMcpServer } from './server';
import { buildDefaultDeps } from './deps';
import type { McpStatus } from '../../types/phosphor.d';

export type { McpStatus };

/**
 * Owns the local MCP server's lifecycle: loading/saving its (off-by-default)
 * config, starting/stopping the loopback HTTP listener, and reacting to
 * vault open/lock/unlock/close events so the Settings UI status stays live.
 * A singleton instance (`mcpController`) is created once and wired up from
 * `src/main/index.ts`.
 */
class McpController {
  private userDataDir: string | null = null;
  private config: McpConfig = {
    enabled: false,
    port: DEFAULT_PORT,
    tokenHash: null,
    tokenCreatedAt: null,
    writeEnabled: false
  };
  private server: http.Server | null = null;
  private lastError: string | null = null;
  private statusListeners = new Set<(status: McpStatus) => void>();
  private unsubscribeVaultState: (() => void) | null = null;
  private mainWindow: BrowserWindow | null = null;

  /** Called once from `ipcHandlers.ts` so post-write notifications have a window to send to. */
  attachWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  private getMainWindow = (): BrowserWindow | null => {
    return this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
  };

  async init(userDataDir: string): Promise<void> {
    this.userDataDir = userDataDir;
    this.config = await loadConfig(userDataDir);
    this.unsubscribeVaultState = vaultState.onChange(() => this.notify());
    if (this.config.enabled) {
      await this.startListening();
    }
  }

  onStatusChange(cb: (status: McpStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  async getStatus(): Promise<McpStatus> {
    return {
      enabled: this.config.enabled,
      listening: this.server !== null,
      port: this.config.port,
      error: this.lastError,
      hasToken: this.config.tokenHash !== null,
      tokenCreatedAt: this.config.tokenCreatedAt,
      vaultReadable: await vaultState.isReadable(),
      writeEnabled: this.config.enabled && this.config.writeEnabled
    };
  }

  async enable(): Promise<McpStatus> {
    this.config.enabled = true;
    await this.persist();
    await this.startListening();
    return this.getStatus();
  }

  async disable(): Promise<McpStatus> {
    this.config.enabled = false;
    // Re-enabling read access later must never silently restore write
    // access without a fresh confirmation from the user.
    this.config.writeEnabled = false;
    await this.persist();
    await this.stopListening();
    return this.getStatus();
  }

  /** Refused (config/status unchanged) if the server itself is disabled - enable it first. */
  async setWriteEnabled(enabled: boolean): Promise<McpStatus> {
    if (enabled && !this.config.enabled) {
      return this.getStatus();
    }
    this.config.writeEnabled = enabled;
    await this.persist();
    this.notify();
    return this.getStatus();
  }

  async setPort(port: number): Promise<McpStatus> {
    this.config.port = port;
    await this.persist();
    if (this.server) {
      await this.stopListening();
      await this.startListening();
    }
    return this.getStatus();
  }

  /**
   * Generates a new token and returns the plaintext ONCE - only its hash is
   * ever persisted. Any client using the previous token is rejected on its
   * next request (sessions are stateless, so there's nothing else to tear
   * down).
   */
  async regenerateToken(): Promise<string> {
    const token = generateToken();
    this.config.tokenHash = hashToken(token);
    this.config.tokenCreatedAt = new Date().toISOString();
    await this.persist();
    this.notify();
    return token;
  }

  private async persist(): Promise<void> {
    if (!this.userDataDir) return;
    await saveConfig(this.userDataDir, this.config);
  }

  private notify(): void {
    if (this.statusListeners.size === 0) return;
    this.getStatus()
      .then((status) => {
        for (const cb of this.statusListeners) cb(status);
      })
      .catch((err) => console.error('[MCP] failed to compute status:', err));
  }

  private async startListening(): Promise<void> {
    if (this.server) return;

    const listener = createRequestListener({
      getTokenHash: () => this.config.tokenHash,
      getPort: () => this.config.port,
      buildServer: () =>
        createPhosphorMcpServer(
          buildDefaultDeps({
            isWriteEnabled: () => this.config.enabled && this.config.writeEnabled,
            getMainWindow: this.getMainWindow
          })
        )
    });
    const server = http.createServer(listener);

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.config.port, '127.0.0.1');
      });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        throw new Error('MCP server bound to an unexpected address');
      }
      this.server = server;
      this.lastError = null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.lastError = code === 'EADDRINUSE' ? 'PORT_IN_USE' : (err as Error).message;
      this.server = null;
      // Don't fall back to a random port: that would silently invalidate
      // every client config that hard-codes this port.
    }
    this.notify();
  }

  private async stopListening(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    this.notify();
  }

  async shutdown(): Promise<void> {
    this.unsubscribeVaultState?.();
    this.unsubscribeVaultState = null;
    await this.stopListening();
  }
}

export const mcpController = new McpController();

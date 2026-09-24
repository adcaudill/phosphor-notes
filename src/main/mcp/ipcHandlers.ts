import { ipcMain, BrowserWindow } from 'electron';
import { mcpController } from './controller';
import { auditLog } from './audit';
import type { McpClientConfig } from '../../types/phosphor.d';

/**
 * Narrow, dedicated IPC channels for MCP settings - deliberately not folded
 * into the generic `settings:get`/`settings:set` channels, since those
 * broadcast the full settings object on every change and are handled
 * uniformly for arbitrary keys. The bearer token's hash must never be
 * readable or writable through that broader path.
 */
export function setupMcpIPC(mainWindow: BrowserWindow): void {
  mcpController.attachWindow(mainWindow);

  ipcMain.handle('mcp:get-status', () => mcpController.getStatus());

  ipcMain.handle('mcp:set-enabled', (_, enabled: boolean) =>
    enabled ? mcpController.enable() : mcpController.disable()
  );

  ipcMain.handle('mcp:set-write-enabled', (_, enabled: boolean) =>
    mcpController.setWriteEnabled(enabled === true)
  );

  ipcMain.handle('mcp:set-port', (_, port: number) => mcpController.setPort(port));

  ipcMain.handle('mcp:regenerate-token', () => mcpController.regenerateToken());

  ipcMain.handle('mcp:get-activity', () => auditLog.recent());

  ipcMain.handle('mcp:get-client-config', async (_, token: string): Promise<McpClientConfig> => {
    const status = await mcpController.getStatus();
    const url = `http://127.0.0.1:${status.port}/mcp`;
    return {
      url,
      claudeCode: `claude mcp add --transport http phosphor ${url} --header "Authorization: Bearer ${token}"`,
      mcpRemote: {
        command: 'npx',
        args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${PHOSPHOR_AUTH}'],
        env: { PHOSPHOR_AUTH: `Bearer ${token}` }
      }
    };
  });

  mcpController.onStatusChange((status) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp:status-changed', status);
    }
  });
}

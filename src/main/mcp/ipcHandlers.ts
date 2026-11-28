import { ipcMain, BrowserWindow } from 'electron';
import { mcpController } from './controller';
import { auditLog } from './audit';
import * as vaultState from '../vaultState';
import * as vaultWriter from '../vaultWriter';
import * as noteHistory from '../noteHistory';
import { notifyNoteWritten } from './deps';
import { findLinkCandidates, afterNoteRenamed } from '../noteOps';
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

  ipcMain.handle('mcp:set-edit-enabled', (_, enabled: boolean) =>
    mcpController.setEditEnabled(enabled === true)
  );

  ipcMain.handle('mcp:set-organize-enabled', (_, enabled: boolean) =>
    mcpController.setOrganizeEnabled(enabled === true)
  );

  ipcMain.handle('mcp:set-delete-enabled', (_, enabled: boolean) =>
    mcpController.setDeleteEnabled(enabled === true)
  );

  ipcMain.handle('mcp:set-write-scope', (_, allow: unknown, deny: unknown) =>
    mcpController.setWriteScope(allow, deny)
  );

  ipcMain.handle('mcp:set-port', (_, port: number) => mcpController.setPort(port));

  ipcMain.handle('mcp:regenerate-token', () => mcpController.regenerateToken());

  ipcMain.handle('mcp:get-activity', () => auditLog.recent());

  // Versions of notes that MCP writes replaced ("Recent AI changes"), newest first.
  ipcMain.handle('mcp:list-versions', async (_, limit?: number) => {
    const vaultPath = vaultState.getVaultPath();
    if (!vaultPath) return [];
    const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 30;
    // A rename and the link rewrites it caused share an opId; show the rename
    // as one row (reverting it puts the links back too) rather than one per note.
    const all = await noteHistory.listVersions(vaultPath, { limit: 1000 });
    const renameOps = new Set(all.filter((v) => v.kind === 'rename' && v.opId).map((v) => v.opId));
    return all
      .filter((v) => v.kind === 'rename' || !v.opId || !renameOps.has(v.opId))
      .slice(0, max);
  });

  // Revert from Settings: a user action, so the MCP write scope doesn't apply,
  // but the content being replaced is still saved so the revert can be undone.
  ipcMain.handle('mcp:restore-version', async (_, id: string) => {
    const vaultPath = vaultState.getVaultPath();
    if (!vaultPath) throw new Error('No vault is open');
    const { entry } = await noteHistory.readVersion(vaultPath, String(id));
    if (entry.kind === 'rename' && entry.fromPath) {
      // Undo a rename by moving the note back, which also puts its links back.
      const moved = await vaultWriter.renameNote(vaultPath, entry.path, entry.fromPath, {
        expectedGeneration: vaultState.getGeneration(),
        includeChildren: entry.includeChildren,
        linkCandidates: (paths) => findLinkCandidates(paths) ?? [],
        history: { tool: 'revert (app)' }
      });
      await afterNoteRenamed(vaultPath, moved, mainWindow);
      return { path: moved.to, versionId: moved.versionId };
    }
    const result = await vaultWriter.restoreVersion(vaultPath, String(id), {
      expectedGeneration: vaultState.getGeneration(),
      history: { tool: 'revert (app)' }
    });
    await notifyNoteWritten(
      vaultPath,
      result.path,
      { created: result.created, parentsCreated: [] },
      mainWindow
    );
    return result;
  });

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

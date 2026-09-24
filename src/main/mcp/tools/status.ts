import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'path';
import type { McpDeps } from '../deps';
import { toCallToolResult } from '../toolkit';
import { auditLog } from '../audit';

export function registerStatusTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    'get_vault_status',
    {
      title: 'Get vault status',
      description:
        'Report whether a Phosphor Notes vault is open, encrypted, and currently unlocked/readable. ' +
        'This is the only tool that works when the vault is locked or no vault is open - call it ' +
        'first, and if `readable` is false, ask the user to open or unlock the vault in the Phosphor ' +
        'Notes app before calling any other tool. There is no tool to unlock the vault remotely.',
      outputSchema: {
        open: z.boolean(),
        vaultName: z.string().nullable(),
        encrypted: z.boolean(),
        locked: z.boolean(),
        readable: z.boolean(),
        indexReady: z.boolean(),
        appVersion: z.string()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const vaultPath = deps.getVaultPath();
      const open = vaultPath !== null;
      const encrypted = open ? await deps.isEncryptionEnabled(vaultPath) : false;
      const readable = await deps.isReadable();
      auditLog.record({ ts: new Date().toISOString(), tool: 'get_vault_status', ok: true });
      return toCallToolResult({
        open,
        vaultName: vaultPath ? path.basename(vaultPath) : null,
        encrypted,
        locked: open && encrypted && !readable,
        readable,
        indexReady: deps.isIndexReady(),
        appVersion: deps.getAppVersion()
      });
    }
  );
}

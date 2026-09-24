import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as net from 'net';

// controller.ts -> mcp/deps.ts -> store.ts, and store.ts reads app.getPath('userData')
// at module load time (for its own, unrelated settings.json path) - so merely
// importing the controller needs a working electron mock, same as store.test.ts.
vi.mock('electron', () => ({
  app: {
    getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-mcp-controller-electron-')),
    getVersion: () => '0.0.0-test'
  }
}));

import { mcpController } from '../mcp/controller';
import { getConfigPath } from '../mcp/config';
import * as vaultState from '../vaultState';

describe('mcpController', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-mcp-controller-test-'));
    vaultState.setVaultPath(null);
  });

  afterEach(async () => {
    await mcpController.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('does not start listening when the persisted config has enabled:false', async () => {
    await mcpController.init(userDataDir);
    const status = await mcpController.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.listening).toBe(false);
  });

  it('enable() starts listening, persists enabled:true, and disable() stops it', async () => {
    await mcpController.init(userDataDir);

    const afterEnable = await mcpController.enable();
    expect(afterEnable.listening).toBe(true);
    expect(afterEnable.error).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(getConfigPath(userDataDir), 'utf-8'));
    expect(onDisk.enabled).toBe(true);

    // The port is actually bound - a raw TCP connect should succeed.
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: afterEnable.port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    expect(connected).toBe(true);

    const afterDisable = await mcpController.disable();
    expect(afterDisable.listening).toBe(false);

    const onDiskAfter = JSON.parse(fs.readFileSync(getConfigPath(userDataDir), 'utf-8'));
    expect(onDiskAfter.enabled).toBe(false);
  });

  it('regenerateToken persists only a hash, never the plaintext, and returns the plaintext once', async () => {
    await mcpController.init(userDataDir);
    const token = await mcpController.regenerateToken();

    expect(token.startsWith('phos_')).toBe(true);

    const raw = fs.readFileSync(getConfigPath(userDataDir), 'utf-8');
    expect(raw).not.toContain(token);
    const onDisk = JSON.parse(raw);
    expect(typeof onDisk.tokenHash).toBe('string');
    expect(onDisk.tokenHash).not.toBe(token);

    const status = await mcpController.getStatus();
    expect(status.hasToken).toBe(true);
    expect(status.tokenCreatedAt).not.toBeNull();
  });

  it('setPort while listening rebinds to the new port', async () => {
    await mcpController.init(userDataDir);
    const first = await mcpController.enable();
    const firstPort = first.port;

    const second = await mcpController.setPort(firstPort === 47823 ? 47824 : 47823);
    expect(second.listening).toBe(true);
    expect(second.port).not.toBe(firstPort);
  });

  it('surfaces PORT_IN_USE rather than throwing when the configured port is already bound', async () => {
    // Occupy a port with a plain TCP server first.
    const occupied = net.createServer();
    const port = await new Promise<number>((resolve) => {
      occupied.listen(0, '127.0.0.1', () => resolve((occupied.address() as net.AddressInfo).port));
    });

    try {
      await mcpController.init(userDataDir);
      await mcpController.setPort(port); // persists port, but does not (re)start since not enabled
      const status = await mcpController.enable();

      expect(status.listening).toBe(false);
      expect(status.error).toBe('PORT_IN_USE');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it('reports vaultReadable based on the live vault state', async () => {
    await mcpController.init(userDataDir);
    let status = await mcpController.getStatus();
    expect(status.vaultReadable).toBe(false);

    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-mcp-controller-vault-'));
    try {
      vaultState.setVaultPath(vaultDir);
      status = await mcpController.getStatus();
      expect(status.vaultReadable).toBe(true);
    } finally {
      vaultState.setVaultPath(null);
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});

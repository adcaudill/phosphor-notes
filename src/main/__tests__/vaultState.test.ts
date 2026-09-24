import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';

describe('vaultState', () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultstate-test-'));
    // Reset to a known baseline before each test.
    vaultState.setVaultPath(null);
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  it('starts with no vault and no master key', () => {
    expect(vaultState.getVaultPath()).toBeNull();
    expect(vaultState.getMasterKey()).toBeNull();
  });

  it('setVaultPath updates the path, clears any key, and bumps the generation', async () => {
    const key = Buffer.from('a'.repeat(32));
    vaultState.setMasterKey(key);
    expect(vaultState.getMasterKey()).not.toBeNull();

    const genBefore = vaultState.getGeneration();
    const events: vaultState.VaultChangeEvent[] = [];
    const unsubscribe = vaultState.onChange((e) => events.push(e));

    vaultState.setVaultPath(tmpVault);

    expect(vaultState.getVaultPath()).toBe(tmpVault);
    expect(vaultState.getMasterKey()).toBeNull(); // opening a vault always clears any prior key
    expect(vaultState.getGeneration()).toBeGreaterThan(genBefore);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('opened');

    unsubscribe();
  });

  it('reports "switched" when moving between two already-open vaults, and "closed" when set to null', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultstate-test-'));
    try {
      vaultState.setVaultPath(tmpVault);

      const events: vaultState.VaultChangeEvent[] = [];
      const unsubscribe = vaultState.onChange((e) => events.push(e));

      vaultState.setVaultPath(other);
      vaultState.setVaultPath(null);

      unsubscribe();
      expect(events.map((e) => e.reason)).toEqual(['switched', 'closed']);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('setMasterKey/clearMasterKey zero the key buffer in place and emit unlocked/locked', () => {
    vaultState.setVaultPath(tmpVault);

    const events: vaultState.VaultChangeEvent[] = [];
    const unsubscribe = vaultState.onChange((e) => events.push(e));

    const key = Buffer.from('b'.repeat(32));
    vaultState.setMasterKey(key);
    expect(vaultState.getMasterKey()).toBe(key);

    const cleared = vaultState.clearMasterKey();
    expect(cleared).toBe(true);
    expect(vaultState.getMasterKey()).toBeNull();
    // sodium_memzero mutates the buffer we handed it, in place.
    expect(key.every((b) => b === 0)).toBe(true);

    // Clearing again when there's nothing to clear is a no-op, and does not
    // emit another 'locked' event.
    const clearedAgain = vaultState.clearMasterKey();
    expect(clearedAgain).toBe(false);

    unsubscribe();
    expect(events.map((e) => e.reason)).toEqual(['unlocked', 'locked']);
  });

  it('isEncryptionEnabled reflects whether .phosphor/security.json exists', async () => {
    expect(await vaultState.isEncryptionEnabled(tmpVault)).toBe(false);

    const securityDir = path.join(tmpVault, '.phosphor');
    fs.mkdirSync(securityDir, { recursive: true });
    fs.writeFileSync(path.join(securityDir, 'security.json'), '{}');

    expect(await vaultState.isEncryptionEnabled(tmpVault)).toBe(true);
  });

  it('isReadable is false with no vault open, true for an unencrypted open vault', async () => {
    expect(await vaultState.isReadable()).toBe(false);

    vaultState.setVaultPath(tmpVault);
    expect(await vaultState.isReadable()).toBe(true);
  });

  it('isReadable is false when the vault is encrypted and locked, true once a key is set', async () => {
    const securityDir = path.join(tmpVault, '.phosphor');
    fs.mkdirSync(securityDir, { recursive: true });
    fs.writeFileSync(path.join(securityDir, 'security.json'), '{}');

    vaultState.setVaultPath(tmpVault);
    expect(await vaultState.isReadable()).toBe(false);

    vaultState.setMasterKey(Buffer.from('c'.repeat(32)));
    expect(await vaultState.isReadable()).toBe(true);

    vaultState.clearMasterKey();
    expect(await vaultState.isReadable()).toBe(false);
  });
});

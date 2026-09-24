import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import * as crypto from '../crypto';
import {
  readDecrypted,
  readNoteText,
  listNotes,
  VaultLockedError,
  NoteNotFoundError,
  DecryptError,
  PathNotAllowedError
} from '../vaultReader';

describe('vaultReader', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultreader-test-'));
    vaultState.setVaultPath(null);
  });

  afterEach(() => {
    vaultState.setVaultPath(null);
    fs.rmSync(vault, { recursive: true, force: true });
  });

  describe('readDecrypted', () => {
    it('returns a plaintext file as-is', async () => {
      const p = path.join(vault, 'note.md');
      fs.writeFileSync(p, 'hello world');

      const out = await readDecrypted(p);
      expect(out.toString('utf-8')).toBe('hello world');
    });

    it('decrypts an encrypted file when a master key is available', async () => {
      const salt = crypto.generateSalt();
      const key = crypto.deriveMasterKey('correct-horse', salt);
      const blob = crypto.encryptBuffer(Buffer.from('secret content'), key);

      const p = path.join(vault, 'note.md');
      fs.writeFileSync(p, blob);

      vaultState.setVaultPath(vault);
      vaultState.setMasterKey(key);

      const out = await readDecrypted(p);
      expect(out.toString('utf-8')).toBe('secret content');
    });

    it('throws VaultLockedError for an encrypted file with no key available', async () => {
      const salt = crypto.generateSalt();
      const key = crypto.deriveMasterKey('correct-horse', salt);
      const blob = crypto.encryptBuffer(Buffer.from('secret content'), key);

      const p = path.join(vault, 'note.md');
      fs.writeFileSync(p, blob);

      // No vault open, no key set.
      await expect(readDecrypted(p)).rejects.toThrow(VaultLockedError);
    });

    it('throws DecryptError for tampered ciphertext', async () => {
      const salt = crypto.generateSalt();
      const key = crypto.deriveMasterKey('correct-horse', salt);
      const blob = crypto.encryptBuffer(Buffer.from('secret content'), key);
      const tampered = Buffer.from(blob);
      tampered[tampered.length - 1] ^= 0xff;

      const p = path.join(vault, 'note.md');
      fs.writeFileSync(p, tampered);

      vaultState.setVaultPath(vault);
      vaultState.setMasterKey(key);

      await expect(readDecrypted(p)).rejects.toThrow(DecryptError);
    });
  });

  describe('readNoteText', () => {
    it('reads a plaintext note by vault-relative path', async () => {
      fs.mkdirSync(path.join(vault, 'People'));
      fs.writeFileSync(path.join(vault, 'People', 'John.md'), 'about john');

      const text = await readNoteText(vault, 'People/John.md');
      expect(text).toBe('about john');
    });

    it('throws NoteNotFoundError for a missing note, without creating it', async () => {
      await expect(readNoteText(vault, 'missing.md')).rejects.toThrow(NoteNotFoundError);
      expect(fs.existsSync(path.join(vault, 'missing.md'))).toBe(false);
    });

    it('throws PathNotAllowedError for a path-traversal attempt', async () => {
      await expect(readNoteText(vault, '../outside.md')).rejects.toThrow(PathNotAllowedError);
    });
  });

  describe('listNotes', () => {
    it('lists notes recursively, skipping dotfiles/dirs and .bak files', async () => {
      fs.writeFileSync(path.join(vault, 'a.md'), '1');
      fs.mkdirSync(path.join(vault, 'People'));
      fs.writeFileSync(path.join(vault, 'People', 'John.md'), '2');
      fs.writeFileSync(path.join(vault, 'a.md.bak'), 'backup');
      fs.mkdirSync(path.join(vault, '.phosphor'));
      fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
      fs.writeFileSync(path.join(vault, 'notes.txt'), 'not markdown');

      const notes = await listNotes(vault);
      const paths = notes.map((n) => n.path).sort();
      expect(paths).toEqual(['People/John.md', 'a.md']);
    });

    it('scopes listing to a subfolder when given', async () => {
      fs.writeFileSync(path.join(vault, 'top.md'), '1');
      fs.mkdirSync(path.join(vault, 'People'));
      fs.writeFileSync(path.join(vault, 'People', 'John.md'), '2');

      const notes = await listNotes(vault, 'People');
      expect(notes.map((n) => n.path)).toEqual(['People/John.md']);
    });
  });
});

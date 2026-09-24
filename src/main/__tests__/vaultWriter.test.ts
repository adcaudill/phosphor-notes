import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import * as crypto from '../crypto';
import {
  createNote,
  appendToNote,
  insertUnderBullet,
  ensureParentFilesExist,
  encodeForVault,
  withFileLock,
  NoteAlreadyExistsError,
  VaultStateChangedError,
  VaultLockedError,
  NoteNotFoundError,
  DecryptError,
  InvalidArgumentError,
  BulletNotFoundError
} from '../vaultWriter';

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}

describe('vaultWriter', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultwriter-test-'));
    vaultState.setVaultPath(null);
  });

  afterEach(() => {
    vaultState.setVaultPath(null);
    fs.rmSync(vault, { recursive: true, force: true });
  });

  describe('createNote', () => {
    it('creates a plaintext note with generated frontmatter', async () => {
      const gen = vaultState.getGeneration();
      const result = await createNote(vault, 'Notes.md', 'Hello world', { expectedGeneration: gen });

      expect(result).toMatchObject({ path: 'Notes.md', created: true, overwritten: false, mode: 'freeform' });
      const onDisk = fs.readFileSync(path.join(vault, 'Notes.md'), 'utf-8');
      expect(onDisk).toBe('---\ntitle: Notes\n---\nHello world\n');
    });

    it('uses content verbatim when it already has its own frontmatter', async () => {
      const gen = vaultState.getGeneration();
      const content = '---\ntitle: Custom\nmode: outliner\n---\n- a\n';
      const result = await createNote(vault, 'Custom.md', content, { expectedGeneration: gen });

      expect(result.mode).toBe('outliner');
      expect(fs.readFileSync(path.join(vault, 'Custom.md'), 'utf-8')).toBe(content);
    });

    it('rejects passing both mode and content with its own frontmatter', async () => {
      const gen = vaultState.getGeneration();
      const content = '---\ntitle: Custom\n---\nbody';
      await expect(
        createNote(vault, 'Custom.md', content, { mode: 'outliner', expectedGeneration: gen })
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('refuses to overwrite an existing note by default, leaving it untouched', async () => {
      fs.writeFileSync(path.join(vault, 'Existing.md'), 'original');
      const gen = vaultState.getGeneration();

      await expect(
        createNote(vault, 'Existing.md', 'new content', { expectedGeneration: gen })
      ).rejects.toThrow(NoteAlreadyExistsError);
      expect(fs.readFileSync(path.join(vault, 'Existing.md'), 'utf-8')).toBe('original');
    });

    it('backs up the previous content when overwrite:true is passed', async () => {
      fs.writeFileSync(path.join(vault, 'Existing.md'), 'original content');
      const gen = vaultState.getGeneration();

      const result = await createNote(vault, 'Existing.md', 'replacement', {
        overwrite: true,
        expectedGeneration: gen
      });

      expect(result.overwritten).toBe(true);
      expect(result.backupPath).toMatch(/^Existing\.\d+\.md\.bak$/);
      const backupContent = fs.readFileSync(path.join(vault, result.backupPath!), 'utf-8');
      expect(backupContent).toBe('original content');
      expect(fs.readFileSync(path.join(vault, 'Existing.md'), 'utf-8')).toContain('replacement');
    });

    it('creates parent stub files for a nested path', async () => {
      const gen = vaultState.getGeneration();
      const result = await createNote(vault, 'Projects/Foo/Bar.md', 'body', { expectedGeneration: gen });

      expect(result.parentsCreated.sort()).toEqual(['Projects.md', 'Projects/Foo.md']);
      expect(fs.existsSync(path.join(vault, 'Projects.md'))).toBe(true);
      expect(fs.existsSync(path.join(vault, 'Projects/Foo.md'))).toBe(true);
    });

    it('does not overwrite an existing parent stub', async () => {
      fs.mkdirSync(path.join(vault, 'Projects'));
      fs.writeFileSync(path.join(vault, 'Projects.md'), 'already had content');
      const gen = vaultState.getGeneration();

      await createNote(vault, 'Projects/Foo.md', 'body', { expectedGeneration: gen });

      expect(fs.readFileSync(path.join(vault, 'Projects.md'), 'utf-8')).toBe('already had content');
    });

    it('aborts before writing anything if the generation has changed', async () => {
      const gen = vaultState.getGeneration();
      vaultState.setVaultPath(vault); // bumps generation

      await expect(
        createNote(vault, 'Notes.md', 'body', { expectedGeneration: gen })
      ).rejects.toThrow(VaultStateChangedError);
      expect(fs.existsSync(path.join(vault, 'Notes.md'))).toBe(false);
    });

    describe('encryption', () => {
      beforeEach(() => {
        fs.mkdirSync(path.join(vault, '.phosphor'), { recursive: true });
        fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
      });

      it('encrypts new note content and parent stubs when a key is present', async () => {
        const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
        vaultState.setVaultPath(vault);
        vaultState.setMasterKey(key);
        const gen = vaultState.getGeneration();

        await createNote(vault, 'Projects/Foo.md', 'secret body', { expectedGeneration: gen });

        const raw = fs.readFileSync(path.join(vault, 'Projects/Foo.md'));
        expect(crypto.isEncrypted(raw)).toBe(true);
        expect(crypto.decryptBuffer(raw, key).toString('utf-8')).toContain('secret body');

        const stubRaw = fs.readFileSync(path.join(vault, 'Projects.md'));
        expect(crypto.isEncrypted(stubRaw)).toBe(true);
      });

      it('throws VaultLockedError and writes nothing anywhere when the vault is configured-encrypted but no key is present', async () => {
        vaultState.setVaultPath(vault); // security.json present, no setMasterKey call: locked
        const gen = vaultState.getGeneration();

        await expect(
          createNote(vault, 'Projects/Foo.md', 'secret body', { expectedGeneration: gen })
        ).rejects.toThrow(VaultLockedError);

        // No plaintext (or any file at all) anywhere under the target path.
        expect(fs.existsSync(path.join(vault, 'Projects/Foo.md'))).toBe(false);
        expect(fs.existsSync(path.join(vault, 'Projects.md'))).toBe(false);
        const allFiles = listAllFiles(vault).map((f) => path.relative(vault, f));
        expect(allFiles).toEqual(['.phosphor/security.json']);
      });
    });
  });

  describe('appendToNote', () => {
    it('throws NoteNotFoundError for a missing note and creates nothing', async () => {
      const gen = vaultState.getGeneration();
      await expect(
        appendToNote(vault, 'Missing.md', 'text', { expectedGeneration: gen })
      ).rejects.toThrow(NoteNotFoundError);
      expect(fs.existsSync(path.join(vault, 'Missing.md'))).toBe(false);
    });

    it('creates the note first when createIfMissing is given', async () => {
      const gen = vaultState.getGeneration();
      const result = await appendToNote(vault, '2026-09-23.md', 'Buy milk', {
        expectedGeneration: gen,
        createIfMissing: { frontmatter: '---\ntitle: September 23, 2026\ntype: daily\n---' }
      });

      expect(result.created).toBe(true);
      expect(fs.readFileSync(path.join(vault, '2026-09-23.md'), 'utf-8')).toBe(
        '---\ntitle: September 23, 2026\ntype: daily\n---\nBuy milk\n'
      );
    });

    it('detects outliner mode from the existing note and appends bullets', async () => {
      fs.writeFileSync(
        path.join(vault, 'Journal.md'),
        '---\nmode: outliner\n---\n- a\n    - b\n'
      );
      const gen = vaultState.getGeneration();
      const result = await appendToNote(vault, 'Journal.md', 'c\nd', { expectedGeneration: gen });

      expect(result.mode).toBe('outliner');
      expect(fs.readFileSync(path.join(vault, 'Journal.md'), 'utf-8')).toBe(
        '---\nmode: outliner\n---\n- a\n    - b\n- c\n- d\n'
      );
    });

    it('appends a freeform paragraph with blank-line separation', async () => {
      fs.writeFileSync(path.join(vault, 'Notes.md'), 'First paragraph.');
      const gen = vaultState.getGeneration();
      await appendToNote(vault, 'Notes.md', 'Second paragraph.', { expectedGeneration: gen });

      expect(fs.readFileSync(path.join(vault, 'Notes.md'), 'utf-8')).toBe(
        'First paragraph.\n\nSecond paragraph.\n'
      );
    });

    it('rejects empty content without touching the file', async () => {
      fs.writeFileSync(path.join(vault, 'Notes.md'), 'original');
      const gen = vaultState.getGeneration();
      await expect(appendToNote(vault, 'Notes.md', '', { expectedGeneration: gen })).rejects.toThrow(
        InvalidArgumentError
      );
      expect(fs.readFileSync(path.join(vault, 'Notes.md'), 'utf-8')).toBe('original');
    });

    describe('encryption', () => {
      beforeEach(() => {
        fs.mkdirSync(path.join(vault, '.phosphor'), { recursive: true });
        fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
      });

      it('keeps an already-encrypted note encrypted on append', async () => {
        const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
        const blob = crypto.encryptBuffer(Buffer.from('Original.'), key);
        fs.writeFileSync(path.join(vault, 'Secret.md'), blob);

        vaultState.setVaultPath(vault);
        vaultState.setMasterKey(key);
        const gen = vaultState.getGeneration();

        await appendToNote(vault, 'Secret.md', 'More.', { expectedGeneration: gen });

        const raw = fs.readFileSync(path.join(vault, 'Secret.md'));
        expect(crypto.isEncrypted(raw)).toBe(true);
        expect(crypto.decryptBuffer(raw, key).toString('utf-8')).toBe('Original.\n\nMore.\n');
      });

      it('throws DecryptError with the wrong key and leaves the file untouched', async () => {
        const rightKey = crypto.deriveMasterKey('right', crypto.generateSalt());
        const wrongKey = crypto.deriveMasterKey('wrong', crypto.generateSalt());
        const blob = crypto.encryptBuffer(Buffer.from('Original.'), rightKey);
        fs.writeFileSync(path.join(vault, 'Secret.md'), blob);

        vaultState.setVaultPath(vault);
        vaultState.setMasterKey(wrongKey);
        const gen = vaultState.getGeneration();

        await expect(
          appendToNote(vault, 'Secret.md', 'More.', { expectedGeneration: gen })
        ).rejects.toThrow(DecryptError);
        expect(fs.readFileSync(path.join(vault, 'Secret.md'))).toEqual(blob);
      });

      it('throws VaultLockedError for an encrypted note when locked, writing nothing', async () => {
        const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
        const blob = crypto.encryptBuffer(Buffer.from('Original.'), key);
        fs.writeFileSync(path.join(vault, 'Secret.md'), blob);

        vaultState.setVaultPath(vault); // locked: no setMasterKey
        const gen = vaultState.getGeneration();

        await expect(
          appendToNote(vault, 'Secret.md', 'More.', { expectedGeneration: gen })
        ).rejects.toThrow(VaultLockedError);
        expect(fs.readFileSync(path.join(vault, 'Secret.md'))).toEqual(blob);
      });
    });

    it('serializes concurrent appends to the same file so every line lands', async () => {
      fs.writeFileSync(path.join(vault, 'Log.md'), 'start');
      const gen = vaultState.getGeneration();

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          appendToNote(vault, 'Log.md', `line-${i}`, { expectedGeneration: gen })
        )
      );

      const finalContent = fs.readFileSync(path.join(vault, 'Log.md'), 'utf-8');
      for (let i = 0; i < 20; i++) {
        expect(finalContent).toContain(`line-${i}`);
      }
      // No lost updates: "start" plus all 20 appended lines survive (each
      // freeform append also inserts a blank-line separator, since none of
      // these lines look like list items - that's expected, not a lost write).
      const nonBlankLines = finalContent.split('\n').filter((l) => l.trim() !== '');
      expect(nonBlankLines).toHaveLength(21);
    });
  });

  describe('insertUnderBullet', () => {
    const outlinerDoc =
      '---\nmode: outliner\n---\n' +
      '- [[IOmergent]]\n' +
      '    - Meetings\n' +
      '- Personal\n';

    it('inserts as a new child of the matched bullet, on disk', async () => {
      fs.writeFileSync(path.join(vault, 'Journal.md'), outlinerDoc);
      const gen = vaultState.getGeneration();

      const result = await insertUnderBullet(vault, 'Journal.md', 'Meetings', 'Standup', {
        expectedGeneration: gen
      });

      expect(result).toMatchObject({ mode: 'outliner', matchedText: 'Meetings' });
      expect(fs.readFileSync(path.join(vault, 'Journal.md'), 'utf-8')).toBe(
        '---\nmode: outliner\n---\n' +
          '- [[IOmergent]]\n' +
          '    - Meetings\n' +
          '        - Standup\n' +
          '- Personal\n'
      );
    });

    it('throws NoteNotFoundError for a missing note, writing nothing', async () => {
      const gen = vaultState.getGeneration();
      await expect(
        insertUnderBullet(vault, 'Missing.md', 'x', 'y', { expectedGeneration: gen })
      ).rejects.toThrow(NoteNotFoundError);
      expect(fs.existsSync(path.join(vault, 'Missing.md'))).toBe(false);
    });

    it('throws BulletNotFoundError without modifying the file', async () => {
      fs.writeFileSync(path.join(vault, 'Journal.md'), outlinerDoc);
      const gen = vaultState.getGeneration();

      await expect(
        insertUnderBullet(vault, 'Journal.md', 'Nonexistent', 'x', { expectedGeneration: gen })
      ).rejects.toThrow(BulletNotFoundError);
      expect(fs.readFileSync(path.join(vault, 'Journal.md'), 'utf-8')).toBe(outlinerDoc);
    });

    it('aborts before writing anything if the generation has changed', async () => {
      fs.writeFileSync(path.join(vault, 'Journal.md'), outlinerDoc);
      const gen = vaultState.getGeneration();
      vaultState.setVaultPath(vault); // bumps generation

      await expect(
        insertUnderBullet(vault, 'Journal.md', 'Meetings', 'x', { expectedGeneration: gen })
      ).rejects.toThrow(VaultStateChangedError);
      expect(fs.readFileSync(path.join(vault, 'Journal.md'), 'utf-8')).toBe(outlinerDoc);
    });

    describe('encryption', () => {
      beforeEach(() => {
        fs.mkdirSync(path.join(vault, '.phosphor'), { recursive: true });
        fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
      });

      it('keeps an already-encrypted note encrypted after inserting', async () => {
        const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
        const blob = crypto.encryptBuffer(Buffer.from(outlinerDoc), key);
        fs.writeFileSync(path.join(vault, 'Secret.md'), blob);

        vaultState.setVaultPath(vault);
        vaultState.setMasterKey(key);
        const gen = vaultState.getGeneration();

        await insertUnderBullet(vault, 'Secret.md', 'Meetings', 'Standup', {
          expectedGeneration: gen
        });

        const raw = fs.readFileSync(path.join(vault, 'Secret.md'));
        expect(crypto.isEncrypted(raw)).toBe(true);
        expect(crypto.decryptBuffer(raw, key).toString('utf-8')).toContain('        - Standup\n');
      });

      it('throws VaultLockedError when locked, writing nothing', async () => {
        const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
        const blob = crypto.encryptBuffer(Buffer.from(outlinerDoc), key);
        fs.writeFileSync(path.join(vault, 'Secret.md'), blob);

        vaultState.setVaultPath(vault); // locked: no setMasterKey
        const gen = vaultState.getGeneration();

        await expect(
          insertUnderBullet(vault, 'Secret.md', 'Meetings', 'Standup', { expectedGeneration: gen })
        ).rejects.toThrow(VaultLockedError);
        expect(fs.readFileSync(path.join(vault, 'Secret.md'))).toEqual(blob);
      });
    });
  });

  describe('ensureParentFilesExist', () => {
    it('returns an empty array for a top-level path', async () => {
      const created = await ensureParentFilesExist(vault, path.join(vault, 'Top.md'));
      expect(created).toEqual([]);
    });

    it('skips (does not throw) when a stub cannot be encoded because the vault is locked', async () => {
      fs.mkdirSync(path.join(vault, '.phosphor'), { recursive: true });
      fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
      vaultState.setVaultPath(vault); // locked

      const created = await ensureParentFilesExist(vault, path.join(vault, 'Projects/Foo/Bar.md'));
      expect(created).toEqual([]);
      expect(fs.existsSync(path.join(vault, 'Projects.md'))).toBe(false);
    });
  });

  describe('encodeForVault', () => {
    it('returns plaintext unchanged when the vault has no encryption configured', async () => {
      const buf = await encodeForVault(vault, Buffer.from('plain'));
      expect(buf.toString('utf-8')).toBe('plain');
    });
  });

  describe('withFileLock', () => {
    it('runs callers for the same path one at a time, in order', async () => {
      const order: number[] = [];
      const target = path.join(vault, 'x.md');

      await Promise.all([
        withFileLock(target, async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push(1);
        }),
        withFileLock(target, async () => {
          order.push(2);
        })
      ]);

      expect(order).toEqual([1, 2]);
    });

    it('does not serialize callers for different paths', async () => {
      const order: string[] = [];
      await Promise.all([
        withFileLock(path.join(vault, 'a.md'), async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push('a');
        }),
        withFileLock(path.join(vault, 'b.md'), async () => {
          order.push('b');
        })
      ]);
      // 'b' finishes first since it doesn't wait behind 'a'.
      expect(order).toEqual(['b', 'a']);
    });
  });
});

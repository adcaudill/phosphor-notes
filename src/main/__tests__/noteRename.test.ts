import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import * as crypto from '../crypto';
import {
  renameNote,
  deleteNote,
  restoreVersion,
  HasChildNotesError,
  NoteAlreadyExistsError,
  NoteChangedError,
  VaultLockedError,
  InvalidArgumentError
} from '../vaultWriter';
import { listVersions, readVersion } from '../noteHistory';
import { contentHash } from '../contentHash';

describe('renameNote / deleteNote', () => {
  let vault: string;
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf-8');
  const exists = (rel: string): boolean => fs.existsSync(path.join(vault, rel));
  const gen = (): number => vaultState.getGeneration();

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-rename-test-'));
    vaultState.setVaultPath(null);
  });

  afterEach(() => {
    vaultState.setVaultPath(null);
    fs.rmSync(vault, { recursive: true, force: true });
  });

  describe('renameNote', () => {
    it('moves the note and rewrites links to it, grouping the history under one operation', async () => {
      write('Plan.md', 'Plan body, see [[Plan#Goals]].\n');
      write('Index.md', 'Links: [[Plan]], [[Plan|the plan]], [[Other]].\n');
      write('Unrelated.md', 'Nothing here.\n');

      const result = await renameNote(vault, 'Plan.md', 'Archive/Plan 2026.md', {
        expectedGeneration: gen(),
        linkCandidates: ['Index.md', 'Unrelated.md', 'Missing.md'],
        history: { tool: 'move_note' }
      });

      expect(exists('Plan.md')).toBe(false);
      expect(read('Archive/Plan 2026.md')).toBe('Plan body, see [[Archive/Plan 2026#Goals]].\n');
      expect(read('Index.md')).toBe(
        'Links: [[Archive/Plan 2026]], [[Archive/Plan 2026|the plan]], [[Other]].\n'
      );
      expect(read('Unrelated.md')).toBe('Nothing here.\n');
      expect(result.parentsCreated).toEqual(['Archive.md']);
      expect(result.linksUpdated.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'Archive/Plan 2026.md', links: 1 },
        { path: 'Index.md', links: 2 }
      ]);
      expect(result.linksFailed).toEqual([]);

      const versions = await listVersions(vault);
      const renameEntry = versions.find((v) => v.kind === 'rename')!;
      expect(renameEntry).toMatchObject({
        id: result.versionId,
        path: 'Archive/Plan 2026.md',
        fromPath: 'Plan.md',
        tool: 'move_note'
      });
      const contentEntries = versions.filter((v) => v.kind === 'content');
      expect(contentEntries).toHaveLength(2);
      expect(contentEntries.every((v) => v.opId === renameEntry.opId)).toBe(true);
      // The rename shows up in the history of both its old and new path.
      expect((await listVersions(vault, { path: 'Plan.md' })).map((v) => v.id)).toContain(
        renameEntry.id
      );
      expect((await readVersion(vault, renameEntry.id)).raw.length).toBe(0);
    });

    it('never overwrites an existing note, and changes nothing when refused', async () => {
      write('A.md', 'a\n');
      write('B.md', 'b\n');
      write('L.md', '[[A]]\n');
      await expect(
        renameNote(vault, 'A.md', 'B.md', { expectedGeneration: gen(), linkCandidates: ['L.md'] })
      ).rejects.toBeInstanceOf(NoteAlreadyExistsError);
      expect(read('A.md')).toBe('a\n');
      expect(read('B.md')).toBe('b\n');
      expect(read('L.md')).toBe('[[A]]\n');
      await expect(
        renameNote(vault, 'A.md', 'A.md', { expectedGeneration: gen(), linkCandidates: [] })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('refuses a note with child notes unless includeChildren, which moves the subtree and its links', async () => {
      write('People.md', 'Index of [[People/John]].\n');
      write('People/John.md', 'John. Friend of [[People/Jane]]. Up: [[People]].\n');
      write('People/Jane.md', 'Jane.\n');
      write('Home.md', '[[People]] and [[People/Jane#Contact|Jane]]\n');

      await expect(
        renameNote(vault, 'People.md', 'Contacts.md', {
          expectedGeneration: gen(),
          linkCandidates: ['Home.md']
        })
      ).rejects.toBeInstanceOf(HasChildNotesError);
      expect(exists('People.md')).toBe(true);

      const result = await renameNote(vault, 'People.md', 'Contacts.md', {
        expectedGeneration: gen(),
        linkCandidates: ['Home.md'],
        includeChildren: true,
        history: { tool: 'move_note' }
      });
      expect(result.movedChildren).toEqual([
        ['People/Jane.md', 'Contacts/Jane.md'],
        ['People/John.md', 'Contacts/John.md']
      ]);
      expect(exists('People')).toBe(false);
      expect(read('Contacts.md')).toBe('Index of [[Contacts/John]].\n');
      expect(read('Contacts/John.md')).toBe(
        'John. Friend of [[Contacts/Jane]]. Up: [[Contacts]].\n'
      );
      expect(read('Home.md')).toBe('[[Contacts]] and [[Contacts/Jane#Contact|Jane]]\n');
      expect((await listVersions(vault)).find((v) => v.kind === 'rename')).toMatchObject({
        includeChildren: true
      });
    });

    it('leaveChildren moves only the note, and linkCandidates can be computed from the moved paths', async () => {
      write('P.md', 'p\n');
      write('P/C.md', 'c\n');
      write('L.md', '[[P]] [[P/C]]\n');
      const asked: string[][] = [];
      await renameNote(vault, 'P.md', 'Q.md', {
        expectedGeneration: gen(),
        leaveChildren: true,
        linkCandidates: (moved) => {
          asked.push(moved);
          return ['L.md'];
        }
      });
      expect(asked).toEqual([['P.md']]);
      expect(exists('P/C.md')).toBe(true);
      expect(read('L.md')).toBe('[[Q]] [[P/C]]\n');
    });

    it('refuses moving a note with its children into its own child folder', async () => {
      write('P.md', 'p\n');
      write('P/C.md', 'c\n');
      await expect(
        renameNote(vault, 'P.md', 'P/Inner.md', {
          expectedGeneration: gen(),
          linkCandidates: [],
          includeChildren: true
        })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('a dry run reports the plan and changes nothing', async () => {
      write('A.md', 'a\n');
      write('L.md', '[[A]]\n');
      const result = await renameNote(vault, 'A.md', 'New/A.md', {
        expectedGeneration: gen(),
        linkCandidates: ['L.md'],
        dryRun: true,
        history: { tool: 'move_note' }
      });
      expect(result).toMatchObject({
        dryRun: true,
        linksUpdated: [{ path: 'L.md', links: 1 }],
        parentsCreated: ['New.md']
      });
      expect(read('A.md')).toBe('a\n');
      expect(read('L.md')).toBe('[[A]]\n');
      expect(exists('New.md')).toBe(false);
      expect(await listVersions(vault)).toEqual([]);
    });

    it('lets beforeWrite veto any affected note before anything moves', async () => {
      write('A.md', 'a\n');
      write('Locked/L.md', '[[A]]\n');
      const seen: Array<[string, string]> = [];
      await expect(
        renameNote(vault, 'A.md', 'B.md', {
          expectedGeneration: gen(),
          linkCandidates: ['Locked/L.md'],
          beforeWrite: async (rel, role) => {
            seen.push([rel, role]);
            if (rel.startsWith('Locked/')) throw new Error('out of scope');
          }
        })
      ).rejects.toThrow('out of scope');
      expect(seen).toEqual([
        ['A.md', 'source'],
        ['B.md', 'destination'],
        ['Locked/L.md', 'link']
      ]);
      expect(exists('A.md')).toBe(true);
      expect(exists('B.md')).toBe(false);
    });

    it('refuses a stale expectedHash', async () => {
      write('A.md', 'a\n');
      await expect(
        renameNote(vault, 'A.md', 'B.md', {
          expectedGeneration: gen(),
          linkCandidates: [],
          expectedHash: contentHash('different')
        })
      ).rejects.toBeInstanceOf(NoteChangedError);
      expect(exists('A.md')).toBe(true);
    });

    it('handles a case-only rename', async () => {
      write('note.md', 'x\n');
      write('L.md', '[[note]]\n');
      await renameNote(vault, 'note.md', 'Note.md', {
        expectedGeneration: gen(),
        linkCandidates: ['L.md']
      });
      expect(fs.readdirSync(vault).sort()).toEqual(['L.md', 'Note.md']);
      expect(read('L.md')).toBe('[[Note]]\n');
    });

    describe('in an encrypted vault', () => {
      const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
      beforeEach(() => {
        fs.mkdirSync(path.join(vault, '.phosphor'), { recursive: true });
        fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
        vaultState.setVaultPath(vault);
      });

      it('rewrites links inside encrypted notes and keeps them encrypted', async () => {
        vaultState.setMasterKey(key);
        fs.writeFileSync(path.join(vault, 'A.md'), crypto.encryptBuffer(Buffer.from('a\n'), key));
        fs.writeFileSync(
          path.join(vault, 'L.md'),
          crypto.encryptBuffer(Buffer.from('see [[A]]\n'), key)
        );
        await renameNote(vault, 'A.md', 'B.md', {
          expectedGeneration: gen(),
          linkCandidates: ['L.md']
        });
        const raw = fs.readFileSync(path.join(vault, 'L.md'));
        expect(crypto.isEncrypted(raw)).toBe(true);
        expect(crypto.decryptBuffer(raw, key).toString('utf-8')).toBe('see [[B]]\n');
      });

      it('refuses while locked, before moving anything', async () => {
        fs.writeFileSync(path.join(vault, 'A.md'), crypto.encryptBuffer(Buffer.from('a\n'), key));
        fs.writeFileSync(
          path.join(vault, 'L.md'),
          crypto.encryptBuffer(Buffer.from('see [[A]]\n'), key)
        );
        await expect(
          renameNote(vault, 'A.md', 'B.md', { expectedGeneration: gen(), linkCandidates: ['L.md'] })
        ).rejects.toBeInstanceOf(VaultLockedError);
        expect(exists('A.md')).toBe(true);
      });
    });

    it('refuses to restore a rename entry as content', async () => {
      write('A.md', 'a\n');
      const { versionId } = await renameNote(vault, 'A.md', 'B.md', {
        expectedGeneration: gen(),
        linkCandidates: [],
        history: { tool: 'move_note' }
      });
      await expect(
        restoreVersion(vault, versionId!, { expectedGeneration: gen() })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  describe('deleteNote', () => {
    it('saves the content to history, removes the note, and can be restored', async () => {
      write('Gone.md', 'keep me\n');
      const trashed: string[] = [];
      const result = await deleteNote(vault, 'Gone.md', {
        expectedGeneration: gen(),
        history: { tool: 'delete_note' },
        trash: async (abs) => {
          trashed.push(path.basename(abs));
          fs.unlinkSync(abs);
        }
      });
      expect(trashed).toEqual(['Gone.md']);
      expect(exists('Gone.md')).toBe(false);
      const { entry, raw } = await readVersion(vault, result.versionId!);
      expect(entry).toMatchObject({ kind: 'delete', path: 'Gone.md', tool: 'delete_note' });
      expect(raw.toString()).toBe('keep me\n');

      const restored = await restoreVersion(vault, result.versionId!, {
        expectedGeneration: gen()
      });
      expect(restored.created).toBe(true);
      expect(read('Gone.md')).toBe('keep me\n');
    });

    it('a dry run or stale hash deletes nothing', async () => {
      write('Stay.md', 's\n');
      await deleteNote(vault, 'Stay.md', { expectedGeneration: gen(), dryRun: true });
      await expect(
        deleteNote(vault, 'Stay.md', { expectedGeneration: gen(), expectedHash: contentHash('x') })
      ).rejects.toBeInstanceOf(NoteChangedError);
      expect(read('Stay.md')).toBe('s\n');
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  normalizeFolder,
  normalizeFolderList,
  isWithinFolder,
  isInWriteScope,
  assertInWriteScope,
  PathNotInWriteScopeError
} from '../mcp/scope';

describe('MCP write scope', () => {
  it('normalizes user-entered folders and rejects unusable ones', () => {
    expect(normalizeFolder('  Projects\\Work/ ')).toBe('Projects/Work');
    expect(normalizeFolder('/Inbox')).toBe('Inbox');
    expect(normalizeFolder('./Journal/./2026')).toBe('Journal/2026');
    expect(normalizeFolder('')).toBeNull();
    expect(normalizeFolder('/')).toBeNull();
    expect(normalizeFolder('../outside')).toBeNull();
    expect(normalizeFolder('.phosphor')).toBeNull();
    expect(normalizeFolder(42)).toBeNull();
  });

  it('de-duplicates folder lists case-insensitively and drops junk', () => {
    expect(normalizeFolderList(['Inbox', 'inbox/', 'Private', '..', 7])).toEqual([
      'Inbox',
      'Private'
    ]);
    expect(normalizeFolderList('Inbox')).toEqual([]);
  });

  it('treats a folder index note as part of the folder, and matches case-insensitively', () => {
    expect(isWithinFolder('People/John.md', 'People')).toBe(true);
    expect(isWithinFolder('People.md', 'People')).toBe(true);
    expect(isWithinFolder('people/john.md', 'People')).toBe(true);
    expect(isWithinFolder('PeopleExtra/x.md', 'People')).toBe(false);
    expect(isWithinFolder('Other.md', 'People')).toBe(false);
  });

  it('allows everything by default, honors the allow list, and lets deny win', () => {
    const open = { allow: [], deny: [] };
    expect(isInWriteScope('anything.md', open)).toBe(true);

    const limited = { allow: ['Inbox', 'Journal'], deny: ['Journal/Private'] };
    expect(isInWriteScope('Inbox/a.md', limited)).toBe(true);
    expect(isInWriteScope('Journal/2026-09-23.md', limited)).toBe(true);
    expect(isInWriteScope('Journal/Private/x.md', limited)).toBe(false);
    expect(isInWriteScope('Projects/x.md', limited)).toBe(false);
    expect(isInWriteScope('2026-09-23.md', limited)).toBe(false);

    expect(() => assertInWriteScope('Journal/Private/x.md', limited)).toThrow(
      PathNotInWriteScopeError
    );
    expect(() => assertInWriteScope('Projects/x.md', limited)).toThrow(/limited to/);
    expect(() => assertInWriteScope('Inbox/a.md', limited)).not.toThrow();
  });
});

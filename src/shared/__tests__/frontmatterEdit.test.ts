import { describe, it, expect } from 'vitest';
import { updateFrontmatter } from '../frontmatterEdit';
import { extractFrontmatter } from '../../renderer/src/utils/frontmatterUtils';
import { InvalidArgumentError } from '../noteFormat';

describe('updateFrontmatter', () => {
  const doc = '---\ntitle: Plan\n# a comment\nstatus: draft\n---\nBody text.\n';

  it('replaces a key in place, leaving every other line and the body untouched', () => {
    const result = updateFrontmatter(doc, { set: { status: 'final' } });
    expect(result.doc).toBe('---\ntitle: Plan\n# a comment\nstatus: final\n---\nBody text.\n');
    expect(result.keysChanged).toEqual(['status']);
    expect(result.replacedText).toEqual(['status: draft']);
  });

  it('appends new keys and removes others', () => {
    const result = updateFrontmatter(doc, {
      set: { owner: 'Sam', priority: 2 },
      remove: ['status']
    });
    expect(result.doc).toBe(
      '---\ntitle: Plan\n# a comment\nowner: Sam\npriority: 2\n---\nBody text.\n'
    );
  });

  it('quotes values the app parser would otherwise misread, and they round-trip', () => {
    const result = updateFrontmatter(doc, { set: { title: 'Q3: Plan #2' } });
    expect(result.doc).toContain('title: "Q3: Plan #2"');
    const parsed = extractFrontmatter(result.doc).frontmatter!.content.title as string;
    expect(JSON.parse(parsed)).toBe('Q3: Plan #2');
  });

  it('creates frontmatter when the note has none', () => {
    const result = updateFrontmatter('Just a body.\n', { set: { title: 'New' } });
    expect(result.doc).toBe('---\ntitle: New\n---\nJust a body.\n');
    expect(extractFrontmatter(result.doc).content).toBe('Just a body.\n');
  });

  it('adds and removes tags across the forms the app reads, de-duplicating case-insensitively', () => {
    const bracket = updateFrontmatter('---\ntags: [project, urgent]\n---\nx\n', {
      addTags: ['#Review', 'PROJECT'],
      removeTags: ['urgent']
    });
    expect(bracket.doc).toBe('---\ntags: [project, Review]\n---\nx\n');
    expect(bracket.tags).toEqual(['project', 'Review']);

    const comma = updateFrontmatter('---\ntags: a, b\n---\n', { addTags: ['c'] });
    expect(comma.tags).toEqual(['a', 'b', 'c']);

    const yamlList = updateFrontmatter('---\ntags:\n  - a\n  - b\nother: 1\n---\n', {
      removeTags: ['a']
    });
    expect(yamlList.doc).toBe('---\ntags: [b]\nother: 1\n---\n');
    expect(yamlList.replacedText).toEqual(['tags:\n  - a\n  - b']);
  });

  it('removes the tags key when the last tag is removed', () => {
    const result = updateFrontmatter('---\ntitle: T\ntags: [only]\n---\nx\n', {
      removeTags: ['only']
    });
    expect(result.doc).toBe('---\ntitle: T\n---\nx\n');
    expect(result.tags).toEqual([]);
  });

  it('leaves a note without frontmatter alone when there is nothing to do', () => {
    expect(updateFrontmatter('plain\n', { remove: ['missing'] }).doc).toBe('plain\n');
  });

  it('refuses mode changes, invalid keys, multi-line values, and contradictory edits', () => {
    expect(() => updateFrontmatter(doc, { set: { mode: 'outliner' } })).toThrow(/mode/);
    expect(() => updateFrontmatter(doc, { remove: ['mode'] })).toThrow(InvalidArgumentError);
    expect(() => updateFrontmatter(doc, { set: { 'bad key': 'x' } })).toThrow(InvalidArgumentError);
    expect(() => updateFrontmatter(doc, { set: { title: 'two\nlines' } })).toThrow(
      InvalidArgumentError
    );
    expect(() => updateFrontmatter(doc, { set: { tags: ['a'] }, addTags: ['b'] })).toThrow(
      InvalidArgumentError
    );
    expect(() => updateFrontmatter(doc, { set: { status: 'x' }, remove: ['status'] })).toThrow(
      InvalidArgumentError
    );
  });
});

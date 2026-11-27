import { describe, it, expect } from 'vitest';
import {
  getOutline,
  replaceSectionBody,
  deleteSection,
  insertAtSection,
  moveSection,
  SectionNotFoundError,
  AmbiguousSectionError
} from '../noteSections';
import { InvalidArgumentError } from '../noteFormat';

const freeform = [
  '---',
  'title: Plan',
  '---',
  '# Plan',
  '',
  'Intro.',
  '',
  '## Goals',
  '',
  'Ship it.',
  '',
  '```',
  '# not a heading',
  '```',
  '',
  '## Risks',
  '',
  'Scope creep.',
  ''
].join('\n');

const outliner = [
  '---',
  'mode: outliner',
  '---',
  '- Meetings',
  '    - Standup',
  '        - [ ] Follow up',
  '    - Retro',
  '- Projects',
  '    - Phosphor',
  ''
].join('\n');

describe('getOutline', () => {
  it('lists freeform headings with whole-document line numbers, ignoring fenced code', () => {
    const outline = getOutline(freeform);
    expect(outline.mode).toBe('freeform');
    expect(outline.totalLines).toBe(18);
    expect(outline.items).toEqual([
      { line: 4, endLine: 18, level: 1, kind: 'heading', text: 'Plan' },
      { line: 8, endLine: 14, level: 2, kind: 'heading', text: 'Goals' },
      { line: 16, endLine: 18, level: 2, kind: 'heading', text: 'Risks' }
    ]);
  });

  it('lists outliner bullets with depth and subtree extent', () => {
    expect(getOutline(outliner).items).toEqual([
      { line: 4, endLine: 7, level: 1, kind: 'bullet', text: 'Meetings' },
      { line: 5, endLine: 6, level: 2, kind: 'bullet', text: 'Standup' },
      { line: 6, endLine: 6, level: 3, kind: 'bullet', text: 'Follow up' },
      { line: 7, endLine: 7, level: 2, kind: 'bullet', text: 'Retro' },
      { line: 8, endLine: 9, level: 1, kind: 'bullet', text: 'Projects' },
      { line: 9, endLine: 9, level: 2, kind: 'bullet', text: 'Phosphor' }
    ]);
  });
});

describe('locating sections', () => {
  it('refuses missing, ambiguous, non-heading lines, and doubly-specified targets', () => {
    expect(() => deleteSection(freeform, { match: 'nope' })).toThrow(SectionNotFoundError);
    expect(() => deleteSection(outliner, { match: 'e' })).toThrow(AmbiguousSectionError);
    expect(() => deleteSection(freeform, { line: 6 })).toThrow(/not a heading/);
    expect(() => deleteSection(freeform, { match: 'Goals', line: 8 })).toThrow(
      InvalidArgumentError
    );
    expect(() => deleteSection('No headings here.\n', { match: 'x' })).toThrow(/edit_note/);
  });

  it('accepts an occurrence among several matches, or an exact line', () => {
    // "Standup" and "Retro" both contain "t"; occurrence 2 among all "t" matches.
    const byOccurrence = deleteSection(outliner, { match: 'retro', occurrence: 1 });
    expect(byOccurrence.section).toEqual({ line: 7, text: 'Retro' });
    expect(deleteSection(outliner, { line: 9 }).section).toEqual({ line: 9, text: 'Phosphor' });
  });
});

describe('replaceSectionBody', () => {
  it('replaces a freeform section body (subsections included), keeping the heading', () => {
    const result = replaceSectionBody(freeform, { match: 'goals' }, 'Ship it in June.');
    expect(result.doc).toBe(
      [
        '---',
        'title: Plan',
        '---',
        '# Plan',
        '',
        'Intro.',
        '',
        '## Goals',
        '',
        'Ship it in June.',
        '',
        '## Risks',
        '',
        'Scope creep.',
        ''
      ].join('\n')
    );
    expect(result.removedText).toBe('\nShip it.\n\n```\n# not a heading\n```');
  });

  it("replaces an outliner bullet's children, re-indenting the content to fit", () => {
    const result = replaceSectionBody(outliner, { match: 'Meetings' }, '- Planning\n  - Agenda');
    expect(result.doc).toBe(
      [
        '---',
        'mode: outliner',
        '---',
        '- Meetings',
        '    - Planning',
        '        - Agenda',
        '- Projects',
        '    - Phosphor',
        ''
      ].join('\n')
    );
  });
});

describe('deleteSection', () => {
  it('removes a freeform section without leaving doubled blank lines', () => {
    const result = deleteSection(freeform, { match: 'Goals' });
    expect(result.doc).toBe(
      [
        '---',
        'title: Plan',
        '---',
        '# Plan',
        '',
        'Intro.',
        '',
        '## Risks',
        '',
        'Scope creep.',
        ''
      ].join('\n')
    );
  });

  it('removes a bullet and everything nested under it', () => {
    expect(deleteSection(outliner, { match: 'Standup' }).doc).toBe(
      [
        '---',
        'mode: outliner',
        '---',
        '- Meetings',
        '    - Retro',
        '- Projects',
        '    - Phosphor',
        ''
      ].join('\n')
    );
  });
});

describe('insertAtSection', () => {
  it('inserts outliner content at each position, at the right depth', () => {
    const at = (position: 'first_child' | 'last_child' | 'before' | 'after'): string[] =>
      insertAtSection(outliner, { match: 'Meetings' }, 'New', position).doc.split('\n');

    expect(at('first_child').slice(3, 6)).toEqual(['- Meetings', '    - New', '    - Standup']);
    expect(at('last_child').slice(6, 9)).toEqual(['    - Retro', '    - New', '- Projects']);
    expect(at('before').slice(3, 5)).toEqual(['- New', '- Meetings']);
    expect(at('after').slice(7, 9)).toEqual(['- New', '- Projects']);
  });

  it('inserts freeform content inside or around a section with blank-line spacing', () => {
    const first = insertAtSection(freeform, { match: 'Risks' }, 'Budget.', 'first_child');
    expect(first.doc.split('\n').slice(15, 20)).toEqual([
      '## Risks',
      '',
      'Budget.',
      '',
      'Scope creep.'
    ]);
    expect(first.insertedAtLine).toBe(18);

    const after = insertAtSection(freeform, { match: 'Goals' }, '## Timeline\n\nQ3.', 'after');
    expect(after.doc).toContain('```\n\n## Timeline\n\nQ3.\n\n## Risks');
  });

  it('refuses empty content', () => {
    expect(() => insertAtSection(outliner, { match: 'Retro' }, '   \n', 'after')).toThrow(
      InvalidArgumentError
    );
  });
});

describe('moveSection', () => {
  it('moves a bullet subtree under another bullet, re-indenting it', () => {
    const result = moveSection(outliner, { match: 'Standup' }, { match: 'Projects' }, 'last_child');
    expect(result.doc).toBe(
      [
        '---',
        'mode: outliner',
        '---',
        '- Meetings',
        '    - Retro',
        '- Projects',
        '    - Phosphor',
        '    - Standup',
        '        - [ ] Follow up',
        ''
      ].join('\n')
    );
    expect(result.movedToLine).toBe(8);
  });

  it('promotes a bullet to the top level when moved before a top-level bullet', () => {
    const result = moveSection(outliner, { match: 'Phosphor' }, { match: 'Meetings' }, 'before');
    expect(result.doc.split('\n').slice(3, 5)).toEqual(['- Phosphor', '- Meetings']);
  });

  it('moves a freeform section, shifting heading levels to fit', () => {
    const result = moveSection(freeform, { match: 'Risks' }, { match: 'Goals' }, 'first_child');
    expect(result.doc).toBe(
      [
        '---',
        'title: Plan',
        '---',
        '# Plan',
        '',
        'Intro.',
        '',
        '## Goals',
        '',
        '### Risks',
        '',
        'Scope creep.',
        '',
        'Ship it.',
        '',
        '```',
        '# not a heading',
        '```',
        ''
      ].join('\n')
    );
  });

  it('refuses to move a section into itself', () => {
    expect(() =>
      moveSection(outliner, { match: 'Meetings' }, { match: 'Standup' }, 'after')
    ).toThrow(/inside it/);
  });
});

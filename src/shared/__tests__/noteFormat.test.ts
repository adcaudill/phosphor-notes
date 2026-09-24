import { describe, it, expect } from 'vitest';
import {
  detectNoteMode,
  normalizeOutlinerLines,
  formatAppend,
  buildNewNoteFrontmatter,
  buildNewNoteDoc,
  formatTaskLine,
  localDailyNoteFilename,
  insertUnderBullet,
  InvalidArgumentError,
  NotOutlinerModeError,
  BulletNotFoundError,
  AmbiguousMatchError
} from '../noteFormat';

describe('detectNoteMode', () => {
  it('detects outliner mode from frontmatter', () => {
    expect(detectNoteMode('---\nmode: outliner\n---\n- a\n')).toBe('outliner');
  });

  it('treats any other value, or missing mode, as freeform', () => {
    expect(detectNoteMode('---\nmode: outline\n---\ntext')).toBe('freeform');
    expect(detectNoteMode('---\ntitle: X\n---\ntext')).toBe('freeform');
    expect(detectNoteMode('no frontmatter at all')).toBe('freeform');
  });

  it('is case-sensitive (exact match only)', () => {
    expect(detectNoteMode('---\nmode: Outliner\n---\ntext')).toBe('freeform');
  });
});

describe('normalizeOutlinerLines', () => {
  it('bullets plain lines at the top level', () => {
    expect(normalizeOutlinerLines('Call Bob\n\nEmail Alice')).toEqual(['- Call Bob', '- Email Alice']);
  });

  it('drops blank lines', () => {
    expect(normalizeOutlinerLines('a\n\n\nb')).toEqual(['- a', '- b']);
  });

  it('normalizes *, +, and - markers to -', () => {
    expect(normalizeOutlinerLines('- a\n* b\n+ c')).toEqual(['- a', '- b', '- c']);
  });

  it('re-derives a 2-space caller indent to the app convention of 4', () => {
    const result = normalizeOutlinerLines('- Project X\n  - [ ] draft spec\n  - notes\n    - sub');
    expect(result).toEqual([
      '- Project X',
      '    - [ ] draft spec',
      '    - notes',
      '        - sub'
    ]);
  });

  it('handles tab indentation', () => {
    expect(normalizeOutlinerLines('a\n\tb')).toEqual(['- a', '    - b']);
  });

  it('clamps an over-indented first line to level 0', () => {
    expect(normalizeOutlinerLines('        - deep')).toEqual(['- deep']);
  });

  it('clamps any line to at most one level deeper than the previous one', () => {
    // unit is derived as 2 (from "  b"); "c" is indented 14 spaces, which
    // would compute to level 7 - but it can be at most one level past "b"
    // (level 1), so it's clamped to level 2.
    const result = normalizeOutlinerLines('a\n  b\n              c');
    expect(result).toEqual(['- a', '    - b', '        - c']);
  });

  it('treats "[ ] x" (no leading dash) the same as "- [ ] x"', () => {
    expect(normalizeOutlinerLines('[ ] x')).toEqual(['- [ ] x']);
    expect(normalizeOutlinerLines('- [ ] x')).toEqual(['- [ ] x']);
    expect(normalizeOutlinerLines('* [ ] x')).toEqual(['- [ ] x']);
  });

  it('drops a lone bullet marker with nothing after it', () => {
    expect(normalizeOutlinerLines('a\n-\nb')).toEqual(['- a', '- b']);
    expect(normalizeOutlinerLines('a\n- \nb')).toEqual(['- a', '- b']);
  });

  it('does not treat markdown emphasis or a horizontal rule as a bullet marker', () => {
    expect(normalizeOutlinerLines('**bold**')).toEqual(['- **bold**']);
    expect(normalizeOutlinerLines('---')).toEqual(['- ---']);
  });

  it('passes a fenced code block through as a child of the previous bullet, without adding bullets', () => {
    const result = normalizeOutlinerLines('note\n```\ncode line 1\ncode line 2\n```\nafter');
    expect(result).toEqual([
      '- note',
      '    ```',
      '    code line 1',
      '    code line 2',
      '    ```',
      '- after'
    ]);
  });

  it('returns an empty array for input with nothing but blank lines', () => {
    expect(normalizeOutlinerLines('\n\n')).toEqual([]);
  });

  it('re-bases every emitted line by baseLevel, used to nest content under an existing bullet', () => {
    expect(normalizeOutlinerLines('parent item\n  child item', 1)).toEqual([
      '    - parent item',
      '        - child item'
    ]);
  });

  it('defaults baseLevel to 0 (unchanged existing behavior)', () => {
    expect(normalizeOutlinerLines('a\nb')).toEqual(['- a', '- b']);
  });
});

describe('formatAppend (freeform)', () => {
  it('appends a paragraph with blank-line separation', () => {
    const before = '---\ntitle: Ideas\n---\nFirst paragraph.\n\n';
    const { doc, appended } = formatAppend(before, 'Second thought.\nWith two lines.', 'freeform');
    expect(doc).toBe('---\ntitle: Ideas\n---\nFirst paragraph.\n\nSecond thought.\nWith two lines.\n');
    expect(appended).toBe('Second thought.\nWith two lines.');
  });

  it('continues a checklist with a single newline, not a blank line', () => {
    const before = '## Todo\n- [ ] a';
    const { doc } = formatAppend(before, '- [ ] b', 'freeform');
    expect(doc).toBe('## Todo\n- [ ] a\n- [ ] b\n');
  });

  it('separates two plain paragraphs with a blank line even with no trailing newline', () => {
    const { doc } = formatAppend('Para', 'More', 'freeform');
    expect(doc).toBe('Para\n\nMore\n');
  });

  it('appends to an empty, frontmatter-less note with no leading blank line', () => {
    const { doc } = formatAppend('', 'Hello', 'freeform');
    expect(doc).toBe('Hello\n');
  });

  it('normalizes CRLF in the addition', () => {
    const { doc } = formatAppend('Existing', 'a\r\nb', 'freeform');
    expect(doc).toBe('Existing\n\na\nb\n');
  });

  it('throws on whitespace-only content', () => {
    expect(() => formatAppend('Existing', '   \n  ', 'freeform')).toThrow(InvalidArgumentError);
  });

  it('preserves a blank line right after frontmatter (only the end is trimmed)', () => {
    const before = '---\ntitle: X\n---\n\nParagraph.';
    const { doc } = formatAppend(before, 'More.', 'freeform');
    expect(doc).toBe('---\ntitle: X\n---\n\nParagraph.\n\nMore.\n');
  });
});

describe('formatAppend (outliner)', () => {
  const outlinerBefore = '---\nmode: outliner\n---\n- Meeting with team\n    - Discussed roadmap\n';

  it('appends new top-level bullets after existing nested content', () => {
    const { doc } = formatAppend(outlinerBefore, 'Call Bob\n\nEmail Alice', 'outliner');
    expect(doc).toBe(
      '---\nmode: outliner\n---\n- Meeting with team\n    - Discussed roadmap\n- Call Bob\n- Email Alice\n'
    );
  });

  it('re-indents a caller-supplied nested list to the 4-space convention', () => {
    const { appended } = formatAppend(
      outlinerBefore,
      '- Project X\n  - [ ] draft spec\n  - notes\n    - sub',
      'outliner'
    );
    expect(appended).toBe('- Project X\n    - [ ] draft spec\n    - notes\n        - sub');
  });

  it('strips the seeded empty bullet from a freshly-created outliner note before appending', () => {
    const before = '---\ntitle: September 23, 2026\ntype: daily\nmode: outliner\n---\n- ';
    const { doc } = formatAppend(before, '- [ ] Buy milk 📅 2026-10-01', 'outliner');
    expect(doc).toBe(
      '---\ntitle: September 23, 2026\ntype: daily\nmode: outliner\n---\n- [ ] Buy milk 📅 2026-10-01\n'
    );
  });

  it('handles frontmatter with no trailing newline and an empty body', () => {
    const { doc } = formatAppend('---\nmode: outliner\n---', 'x', 'outliner');
    expect(doc).toBe('---\nmode: outliner\n---\n- x\n');
  });

  it('does not strip a real bullet that merely starts with a dash', () => {
    // Only a *trailing line that is nothing but a dash* is the seeded stub -
    // real content must survive.
    const before = '---\nmode: outliner\n---\n- Real content\n';
    const { doc } = formatAppend(before, 'More', 'outliner');
    expect(doc).toBe('---\nmode: outliner\n---\n- Real content\n- More\n');
  });

  it('throws when the addition normalizes to nothing', () => {
    expect(() => formatAppend(outlinerBefore, '\n\n  \n', 'outliner')).toThrow(InvalidArgumentError);
  });
});

describe('buildNewNoteFrontmatter / buildNewNoteDoc', () => {
  it('includes mode for a daily note filename', () => {
    const fm = buildNewNoteFrontmatter('2026-09-23.md', 'outliner');
    expect(fm).toContain('type: daily');
    expect(fm).toContain('mode: outliner');
  });

  it('treats a menu-style "Untitled <date>.md" as a daily note too (suffix match)', () => {
    const fm = buildNewNoteFrontmatter('Untitled 2026-09-23.md', 'outliner');
    expect(fm).toContain('type: daily');
  });

  it('includes mode for a non-daily note filename (fixing the gap in generateDefaultFrontmatter)', () => {
    const fm = buildNewNoteFrontmatter('Projects/Plan.md', 'outliner');
    expect(fm).toBe('---\ntitle: Projects/Plan\nmode: outliner\n---');
  });

  it('omits the mode line entirely for a freeform non-daily note', () => {
    const fm = buildNewNoteFrontmatter('Projects/Plan.md');
    expect(fm).toBe('---\ntitle: Projects/Plan\n---');
  });

  it('builds a full outliner document from plain body lines', () => {
    const doc = buildNewNoteDoc('Projects/Plan.md', 'Goal A\nGoal B', 'outliner');
    expect(doc).toBe('---\ntitle: Projects/Plan\nmode: outliner\n---\n- Goal A\n- Goal B\n');
  });

  it('seeds an empty outliner note with a single empty bullet, like the GUI does', () => {
    const doc = buildNewNoteDoc('Projects/Plan.md', '', 'outliner');
    expect(doc).toBe('---\ntitle: Projects/Plan\nmode: outliner\n---\n- \n');
  });

  it('builds a freeform document verbatim', () => {
    const doc = buildNewNoteDoc('Notes.md', 'Just plain text here.');
    expect(doc).toBe('---\ntitle: Notes\n---\nJust plain text here.\n');
  });

  it('handles an empty freeform body', () => {
    const doc = buildNewNoteDoc('Notes.md', '');
    expect(doc).toBe('---\ntitle: Notes\n---\n');
  });
});

describe('formatTaskLine', () => {
  it('formats a basic task', () => {
    expect(formatTaskLine({ text: 'Write report' })).toBe('- [ ] Write report');
  });

  it('formats with a due date', () => {
    expect(formatTaskLine({ text: 'Renew passport', due: '2026-11-01' })).toBe(
      '- [ ] Renew passport 📅 2026-11-01'
    );
  });

  it('formats with due date and recurrence, date before recurrence', () => {
    expect(
      formatTaskLine({ text: 'Renew passport', due: '2026-11-01', recurrence: '+1y' })
    ).toBe('- [ ] Renew passport 📅 2026-11-01 🔁 +1y');
  });

  it('formats a "doing" task with [/]', () => {
    expect(formatTaskLine({ text: 'Draft spec', status: 'doing' })).toBe('- [/] Draft spec');
  });

  it('produces output matching the app\'s own task-line regex', () => {
    const line = formatTaskLine({ text: 'x', due: '2026-01-01', recurrence: '+2w' });
    expect(/^\s*-\s*\[([ x/])\]\s*(.*?)$/.test(line)).toBe(true);
  });

  it('strips a leading checkbox marker the caller already included', () => {
    expect(formatTaskLine({ text: '- [ ] Already bulleted' })).toBe('- [ ] Already bulleted');
    expect(formatTaskLine({ text: '[x] Done already' })).toBe('- [ ] Done already');
  });

  it('rejects multi-line text', () => {
    expect(() => formatTaskLine({ text: 'a\nb' })).toThrow(InvalidArgumentError);
  });

  it('rejects empty text', () => {
    expect(() => formatTaskLine({ text: '   ' })).toThrow(InvalidArgumentError);
  });

  it('rejects an impossible calendar date', () => {
    expect(() => formatTaskLine({ text: 'x', due: '2026-02-30' })).toThrow(InvalidArgumentError);
  });

  it('rejects a malformed recurrence', () => {
    expect(() => formatTaskLine({ text: 'x', recurrence: 'weekly' })).toThrow(InvalidArgumentError);
    expect(() => formatTaskLine({ text: 'x', recurrence: '1w' })).toThrow(InvalidArgumentError);
    expect(() => formatTaskLine({ text: 'x', recurrence: '+1x' })).toThrow(InvalidArgumentError);
  });

  it('rejects text that already embeds a due-date or recurrence emoji', () => {
    expect(() => formatTaskLine({ text: 'x 📅 2026-01-01', due: '2026-01-01' })).toThrow(
      InvalidArgumentError
    );
    expect(() => formatTaskLine({ text: 'x 🔁 +1w' })).toThrow(InvalidArgumentError);
  });
});

describe('localDailyNoteFilename', () => {
  it('formats YYYY-MM-DD.md from local date parts, not UTC', () => {
    // A date whose UTC and local day could differ near midnight - use a
    // fixed, unambiguous local time to make the test deterministic.
    const d = new Date(2026, 0, 5, 23, 30); // Jan 5, 2026, 23:30 local
    expect(localDailyNoteFilename(d)).toBe('2026-01-05.md');
  });

  it('pads single-digit months and days', () => {
    const d = new Date(2026, 2, 4); // March 4, 2026
    expect(localDailyNoteFilename(d)).toBe('2026-03-04.md');
  });
});

describe('insertUnderBullet', () => {
  const fixture =
    '---\nmode: outliner\n---\n' +
    '- [[IOmergent]]\n' +
    '    - Meetings\n' +
    '        - Standup notes\n' +
    '    - Followups\n' +
    '- Personal\n' +
    '    - Groceries\n';

  it('inserts after the last existing child of the matched bullet, before its next sibling', () => {
    const result = insertUnderBullet(fixture, 'Meetings', 'New meeting');
    expect(result.doc).toBe(
      '---\nmode: outliner\n---\n' +
        '- [[IOmergent]]\n' +
        '    - Meetings\n' +
        '        - Standup notes\n' +
        '        - New meeting\n' +
        '    - Followups\n' +
        '- Personal\n' +
        '    - Groceries\n'
    );
    expect(result.matchedLine).toBe(2);
    expect(result.matchedText).toBe('Meetings');
    expect(result.appended).toBe('        - New meeting');
  });

  it('inserts as the first child when the matched bullet has no existing children yet', () => {
    const result = insertUnderBullet(fixture, 'Followups', 'New sub');
    expect(result.doc).toBe(
      '---\nmode: outliner\n---\n' +
        '- [[IOmergent]]\n' +
        '    - Meetings\n' +
        '        - Standup notes\n' +
        '    - Followups\n' +
        '        - New sub\n' +
        '- Personal\n' +
        '    - Groceries\n'
    );
  });

  it('matches a bullet by text with its checkbox marker stripped', () => {
    const doc = '---\nmode: outliner\n---\n- [ ] Buy milk\n- Other\n';
    const result = insertUnderBullet(doc, 'Buy milk', 'Get 2%');
    expect(result.matchedText).toBe('Buy milk');
    expect(result.doc).toBe(
      '---\nmode: outliner\n---\n- [ ] Buy milk\n    - Get 2%\n- Other\n'
    );
  });

  it('does not extend the children block across a top-level wikilink bullet with no relation', () => {
    // "[[IOmergent]]" is matched by a substring of its own bracketed text,
    // with no special wikilink stripping needed.
    const result = insertUnderBullet(fixture, 'IOmergent', 'New top item');
    // IOmergent's children run through "Followups" (its last level-1 child);
    // "Personal" is a sibling at level 0, so insertion lands right before it,
    // as a new level-1 child (baseLevel = parentLevel(0) + 1 = 4 spaces).
    expect(result.doc).toContain('    - Followups\n    - New top item\n- Personal\n');
  });

  it('keeps a blank line inside an existing children block from truncating it', () => {
    const doc = '---\nmode: outliner\n---\n- Parent\n    - Child A\n\n    - Child B\n- Sibling\n';
    const result = insertUnderBullet(doc, 'Parent', 'Child C');
    expect(result.doc).toBe(
      '---\nmode: outliner\n---\n- Parent\n    - Child A\n\n    - Child B\n    - Child C\n- Sibling\n'
    );
  });

  it('throws BulletNotFoundError, and writes nothing, when no bullet matches', () => {
    expect(() => insertUnderBullet(fixture, 'Nonexistent', 'x')).toThrow(BulletNotFoundError);
  });

  it('throws AmbiguousMatchError listing every match when matchText is not unique', () => {
    const doc =
      '---\nmode: outliner\n---\n- Notes\n- Project Notes\n- Other\n';
    let error: unknown;
    try {
      insertUnderBullet(doc, 'Notes', 'x');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AmbiguousMatchError);
    const amb = error as AmbiguousMatchError;
    expect(amb.matches).toEqual([
      { line: 1, text: 'Notes' },
      { line: 2, text: 'Project Notes' }
    ]);
  });

  it('resolves an ambiguous match via an explicit occurrence', () => {
    const doc = '---\nmode: outliner\n---\n- Notes\n- Project Notes\n- Other\n';
    const result = insertUnderBullet(doc, 'Notes', 'x', { occurrence: 2 });
    expect(result.matchedText).toBe('Project Notes');
    expect(result.doc).toBe(
      '---\nmode: outliner\n---\n- Notes\n- Project Notes\n    - x\n- Other\n'
    );
  });

  it('rejects an out-of-range occurrence as ambiguous', () => {
    const doc = '---\nmode: outliner\n---\n- Notes\n- Project Notes\n';
    expect(() => insertUnderBullet(doc, 'Notes', 'x', { occurrence: 5 })).toThrow(
      AmbiguousMatchError
    );
  });

  it('throws NotOutlinerModeError for a freeform note', () => {
    const doc = '---\ntitle: X\n---\nSome paragraph.';
    expect(() => insertUnderBullet(doc, 'Some', 'x')).toThrow(NotOutlinerModeError);
  });

  it('rejects an empty matchText', () => {
    expect(() => insertUnderBullet(fixture, '   ', 'x')).toThrow(InvalidArgumentError);
  });

  it('rejects content that normalizes to nothing', () => {
    expect(() => insertUnderBullet(fixture, 'Meetings', '\n\n  \n')).toThrow(
      InvalidArgumentError
    );
  });
});

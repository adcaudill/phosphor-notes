import { describe, it, expect } from 'vitest';
import { computeNestingGuides, guideBackground } from '../outlinerKeymap';

/** Guides per line, as "line text => columns", for readable expectations. */
function show(lines: string[]): string[] {
  const guides = computeNestingGuides(lines);
  return lines.map((text, i) => `${text} => ${guides[i].join(',')}`);
}

describe('computeNestingGuides', () => {
  it('draws a parent guide on plain child bullets (the old behavior)', () => {
    expect(show(['- Parent', '    - Child', '    - Child 2'])).toEqual([
      '- Parent => ',
      '    - Child => 1',
      '    - Child 2 => 1'
    ]);
  });

  it('keeps the guide unbroken through task lines', () => {
    // The reported case: a parent whose children include tasks lost its line
    // on every task row, leaving gaps between plain sibling bullets.
    expect(
      show([
        '- Weekly team sync',
        '    - [ ] Follow up on findings',
        '    - [x] Send notes',
        '    - Planning session',
        '        - [ ] Book a demo',
        '        - Pricing'
      ])
    ).toEqual([
      '- Weekly team sync => ',
      '    - [ ] Follow up on findings => 1',
      '    - [x] Send notes => 1',
      '    - Planning session => 1',
      '        - [ ] Book a demo => 1,5',
      '        - Pricing => 1,5'
    ]);
  });

  it('keeps the guide through continuation lines and blank lines inside a subtree', () => {
    expect(
      show(['- Parent', '  continued text', '    - Child', '', '    - Child 2', '- Next'])
    ).toEqual([
      '- Parent => ',
      '  continued text => 1',
      '    - Child => 1',
      ' => 1',
      '    - Child 2 => 1',
      '- Next => '
    ]);
  });

  it('draws nothing for a bullet with no child bullets, and stops at the subtree end', () => {
    expect(
      show(['- Leaf', '  its continuation', '', '- Parent', '    - Child', '', '', 'A paragraph'])
    ).toEqual([
      '- Leaf => ',
      '  its continuation => ',
      ' => ',
      '- Parent => ',
      '    - Child => 1',
      ' => ',
      ' => ',
      'A paragraph => '
    ]);
  });

  it('ignores frontmatter and handles deeper nesting and outdents', () => {
    expect(
      show(['---', 'mode: outliner', '---', '- A', '    - B', '        - C', '    - D', '- E'])
    ).toEqual([
      '--- => ',
      'mode: outliner => ',
      '--- => ',
      '- A => ',
      '    - B => 1',
      '        - C => 1,5',
      '    - D => 1',
      '- E => '
    ]);
  });
});

describe('guideBackground', () => {
  it('draws each guide as a fixed 1px band, never a sub-pixel fraction of a column', () => {
    const bg = guideBackground([1, 5]);
    expect(bg).toContain(
      'var(--editor-nesting-guide) calc(calc(1 * var(--editor-column, 1ch)) + 1px)'
    );
    expect(bg).toContain(
      'var(--editor-nesting-guide) calc(calc(5 * var(--editor-column, 1ch)) + 1px)'
    );
    expect(bg).not.toMatch(/\d\.\d+ch/);
  });
});

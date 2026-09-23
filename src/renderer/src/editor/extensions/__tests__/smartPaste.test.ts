import { describe, expect, it } from 'vitest';
import { normalizeOutlinerPaste } from '../smartPaste';

describe('outliner paste normalization', () => {
  it('removes blank lines and makes headings and paragraphs list items', () => {
    const markdown = '# Introductions\n\n- Adam\n\n# Scope';

    expect(normalizeOutlinerPaste(markdown, '    ')).toBe(
      '    - # Introductions\n    - Adam\n    - # Scope'
    );
  });

  it('preserves nested source indentation relative to the pasted item', () => {
    const markdown = '- Parent\n  - Child\n    - Grandchild';

    expect(normalizeOutlinerPaste(markdown, '        ')).toBe(
      '        - Parent\n          - Child\n            - Grandchild'
    );
  });

  it('normalizes other markdown list markers as bullets', () => {
    const markdown = '1. First\n* Second\n  2) Nested';

    expect(normalizeOutlinerPaste(markdown, '')).toBe('- First\n- Second\n  - Nested');
  });
});

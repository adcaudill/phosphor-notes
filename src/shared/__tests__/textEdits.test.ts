import { describe, it, expect } from 'vitest';
import {
  applyTextEdits,
  TextNotFoundError,
  AmbiguousTextError,
  EmptyOldTextError
} from '../textEdits';

describe('applyTextEdits', () => {
  const doc = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';

  it('replaces a unique passage and reports the changed lines', () => {
    const result = applyTextEdits(doc, [{ oldText: 'Second', newText: 'Final' }]);
    expect(result.doc).toBe('# Title\n\nFirst paragraph.\n\nFinal paragraph.\n');
    expect(result.replacements).toBe(1);
    expect(result.changes).toEqual([
      { line: 5, removed: ['Second paragraph.'], added: ['Final paragraph.'] }
    ]);
  });

  it('applies edits in order, each to the result of the previous one', () => {
    const result = applyTextEdits(doc, [
      { oldText: 'First', newText: 'Opening' },
      { oldText: 'Opening paragraph.', newText: 'Opening paragraph, revised.' }
    ]);
    expect(result.doc).toContain('Opening paragraph, revised.');
  });

  it('deletes with an empty newText, including whole lines', () => {
    const result = applyTextEdits(doc, [{ oldText: 'First paragraph.\n\n', newText: '' }]);
    expect(result.doc).toBe('# Title\n\nSecond paragraph.\n');
  });

  it('can span multiple lines and insert new ones', () => {
    const result = applyTextEdits(doc, [
      { oldText: 'First paragraph.', newText: 'First paragraph.\n\n## Added\n\nNew text.' }
    ]);
    expect(result.doc).toBe(
      '# Title\n\nFirst paragraph.\n\n## Added\n\nNew text.\n\nSecond paragraph.\n'
    );
    expect(result.changes[0].added).toEqual(['First paragraph.', '', '## Added', '', 'New text.']);
  });

  it('refuses text that is not there, and applies nothing', () => {
    expect(() =>
      applyTextEdits(doc, [
        { oldText: 'First', newText: 'X' },
        { oldText: 'missing', newText: 'Y' }
      ])
    ).toThrow(TextNotFoundError);
  });

  it('refuses ambiguous text, reporting the lines, unless replaceAll is set', () => {
    const twice = 'a todo\nb\nanother todo\n';
    try {
      applyTextEdits(twice, [{ oldText: 'todo', newText: 'done' }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousTextError);
      expect((err as AmbiguousTextError).lines).toEqual([1, 3]);
    }

    const all = applyTextEdits(twice, [{ oldText: 'todo', newText: 'done', replaceAll: true }]);
    expect(all.doc).toBe('a done\nb\nanother done\n');
    expect(all.replacements).toBe(2);
    expect(all.changes.map((c) => c.line)).toEqual([1, 3]);
  });

  it('treats CRLF in the edit as LF, and rejects an empty oldText', () => {
    const result = applyTextEdits('one\ntwo\n', [{ oldText: 'one\r\ntwo', newText: 'x\r\ny' }]);
    expect(result.doc).toBe('x\ny\n');
    expect(() => applyTextEdits(doc, [{ oldText: '', newText: 'x' }])).toThrow(EmptyOldTextError);
  });

  it('does not count overlapping occurrences twice', () => {
    expect(applyTextEdits('aaa', [{ oldText: 'aa', newText: 'b' }]).doc).toBe('ba');
  });

  it('reports a line changed by several replacements once, with its final text', () => {
    const result = applyTextEdits('ImprovOn and ImprovOn again\nother\n', [
      { oldText: 'ImprovOn', newText: 'Improv On', replaceAll: true }
    ]);
    expect(result.replacements).toBe(2);
    expect(result.changes).toEqual([
      {
        line: 1,
        removed: ['ImprovOn and ImprovOn again'],
        added: ['Improv On and Improv On again']
      }
    ]);
  });

  it('wholeWord and skipLinks make replaceAll safe around longer words and links', () => {
    const doc = 'Melanie met Melanies team. See [[People/Melanie Dworak]]. Melanie agreed.\n';
    const result = applyTextEdits(doc, [
      {
        oldText: 'Melanie',
        newText: '[[People/Melanie Dworak|Melanie]]',
        replaceAll: true,
        wholeWord: true,
        skipLinks: true
      }
    ]);
    expect(result.doc).toBe(
      '[[People/Melanie Dworak|Melanie]] met Melanies team. See [[People/Melanie Dworak]]. ' +
        '[[People/Melanie Dworak|Melanie]] agreed.\n'
    );
    expect(result.replacements).toBe(2);
    expect(result.changes).toHaveLength(1);
  });

  it('counts only eligible matches when deciding whether oldText is ambiguous', () => {
    const doc = 'Ann and [[Ann]]\n';
    expect(() => applyTextEdits(doc, [{ oldText: 'Ann', newText: 'Anne' }])).toThrow(
      AmbiguousTextError
    );
    expect(applyTextEdits(doc, [{ oldText: 'Ann', newText: 'Anne', skipLinks: true }]).doc).toBe(
      'Anne and [[Ann]]\n'
    );
  });
});

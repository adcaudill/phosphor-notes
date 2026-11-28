import { describe, it, expect } from 'vitest';
import { extractTaskRefs, formatTaskLink, replaceTaskLinkTitles } from '../taskLinks';

describe('replaceTaskLinkTitles', () => {
  it('rewrites only the links to that task', () => {
    const doc =
      '- [[_task:k3f9a2xq|Pay rent]]\n- see [[_task:k3f9a2xq]] and [[_task:m8d2c7wa|Other]] and [[Lease]]';
    const r = replaceTaskLinkTitles(doc, 'k3f9a2xq', 'Pay December rent');
    expect(r.changed).toBe(2);
    expect(r.doc).toBe(
      '- [[_task:k3f9a2xq|Pay December rent]]\n- see [[_task:k3f9a2xq|Pay December rent]] and [[_task:m8d2c7wa|Other]] and [[Lease]]'
    );
  });

  it('reports no change when links already match', () => {
    const r = replaceTaskLinkTitles('[[_task:k3f9a2xq|Pay rent]]', 'k3f9a2xq', 'Pay rent');
    expect(r).toEqual({ doc: '[[_task:k3f9a2xq|Pay rent]]', changed: 0 });
  });
});

describe('extractTaskRefs', () => {
  it('finds task links with their line numbers and titles', () => {
    const note = [
      '- Meeting',
      '    - [[_task:k3f9a2xq|Send the summary]]',
      '- See [[Project X]] and [[_task:m8d2c7wa]] twice [[_task:m8d2c7wa|Call]]'
    ].join('\n');
    expect(extractTaskRefs(note)).toEqual([
      { id: 'k3f9a2xq', line: 2, title: 'Send the summary' },
      { id: 'm8d2c7wa', line: 3, title: '' },
      { id: 'm8d2c7wa', line: 3, title: 'Call' }
    ]);
  });

  it('ignores near misses', () => {
    expect(
      extractTaskRefs(
        '[[_task:K3F9A2XQ]] [[_task:short]] [[task:k3f9a2xq]] [[_task:k3f9a2xq|broken'
      )
    ).toEqual([]);
  });
});

describe('formatTaskLink', () => {
  it('writes the id and a title that cannot end the link early', () => {
    expect(formatTaskLink('k3f9a2xq', 'Pay rent')).toBe('[[_task:k3f9a2xq|Pay rent]]');
    expect(formatTaskLink('k3f9a2xq', 'a | b ]] c')).toBe('[[_task:k3f9a2xq|a b c]]');
    expect(formatTaskLink('k3f9a2xq', '  ')).toBe('[[_task:k3f9a2xq]]');
  });
});

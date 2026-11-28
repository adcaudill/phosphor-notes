import { describe, it, expect } from 'vitest';
import { extractTaskRefs, formatTaskLink } from '../taskLinks';

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

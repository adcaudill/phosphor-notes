import { describe, it, expect } from 'vitest';
import { findOccurrences, wikilinkSpans, overlapsAny } from '../textMatch';

describe('findOccurrences', () => {
  it('finds literal, non-overlapping occurrences, case-sensitively by default', () => {
    expect(findOccurrences('aaa', 'aa')).toEqual([0]);
    expect(findOccurrences('Abigail met melanie', 'Abigail')).toEqual([0]);
    expect(findOccurrences('Abigail met melanie', 'melanie', { caseSensitive: false })).toEqual([
      0, 12
    ]);
    expect(findOccurrences('x', '')).toEqual([]);
  });

  it('wholeWord skips matches embedded in longer words but allows punctuation around them', () => {
    const text = "Abigail, Abigails, Abigail's, [[People/Abigail Stone]], xAbigail";
    expect(findOccurrences(text, 'Abigail', { wholeWord: true })).toEqual([0, 19, 39]);
  });

  it('treats a query that starts or ends with punctuation as matching at that edge', () => {
    expect(findOccurrences('mail a@b.com, x@a@b.com', '@b.com', { wholeWord: true })).toEqual([
      6, 17
    ]);
  });

  it('handles non-ASCII letters as word characters', () => {
    expect(findOccurrences('café cafés', 'café', { wholeWord: true })).toEqual([0]);
  });
});

describe('wikilink spans', () => {
  it('finds links and detects overlap', () => {
    const text = 'Hi [[People/Abigail Stone]] and Abigail';
    const spans = wikilinkSpans(text);
    expect(spans).toEqual([[3, 28]]);
    expect(overlapsAny(text.indexOf('Abigail'), 7, spans)).toBe(true);
    expect(overlapsAny(text.lastIndexOf('Abigail'), 7, spans)).toBe(false);
  });
});

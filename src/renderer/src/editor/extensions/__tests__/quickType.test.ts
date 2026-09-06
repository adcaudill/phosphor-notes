import { describe, expect, it } from 'vitest';
import { shouldAttachPunctuation, shouldPreservePeriodSpace } from '../quickType';

describe('Quick Type punctuation handling', () => {
  it('recognizes punctuation that should attach to the accepted word', () => {
    expect(shouldAttachPunctuation(',')).toBe(true);
    expect(shouldAttachPunctuation('!')).toBe(true);
    expect(shouldAttachPunctuation(' ')).toBe(false);
  });

  it('preserves a generated space before an uppercase period-led identifier', () => {
    expect(shouldPreservePeriodSpace('.NET')).toBe(true);
    expect(shouldPreservePeriodSpace('.com')).toBe(false);
    expect(shouldPreservePeriodSpace('. ')).toBe(false);
  });
});

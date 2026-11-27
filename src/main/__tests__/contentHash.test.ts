import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { contentHash } from '../contentHash';

describe('contentHash', () => {
  it('is stable for the same text and differs for different text', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hello!'));
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is not a plain SHA-256 of the content (it is keyed, so it cannot be brute-forced offline)', () => {
    const text = 'SSN 123-45-6789';
    const plain = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
    expect(contentHash(text)).not.toBe(plain);
  });
});

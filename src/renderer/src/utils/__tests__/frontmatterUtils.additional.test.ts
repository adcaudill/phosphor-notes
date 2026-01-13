import { describe, it, expect } from 'vitest';
import { extractFrontmatter, reconstructDocument } from '../frontmatterUtils';

describe('frontmatter parsing edge cases', () => {
  it('trims values and ignores invalid lines', () => {
    const doc = `---
key:   value   
other:42
not-a-kv-line
---
Body`;

    const res = extractFrontmatter(doc);
    expect(res.frontmatter).not.toBeNull();
    expect(res.frontmatter?.content).toHaveProperty('key', 'value');
    expect(res.frontmatter?.content).toHaveProperty('other', '42');
    // invalid line should be ignored
    expect((res.frontmatter?.content as Record<string, unknown>)['not-a-kv-line']).toBeUndefined();
  });

  it('accepts underscore-prefixed keys and empty frontmatter', () => {
    const doc = `---
_meta: yes
---
Content`;

    const res = extractFrontmatter(doc);
    expect(res.frontmatter?.content).toHaveProperty('_meta', 'yes');

    const empty = `---\n---\nStuff`;
    const emptyRes = extractFrontmatter(empty);
    expect(emptyRes.frontmatter).not.toBeNull();
    expect(Object.keys(emptyRes.frontmatter!.content)).toHaveLength(0);
  });

  it('handles closing delimiter followed by multiple newlines', () => {
    const doc = `---\ntitle: X\n---\n\n\nReal`;
    const res = extractFrontmatter(doc);
    expect(res.frontmatter).not.toBeNull();
    expect(res.content).toBe('\n\nReal'); // two leading newlines remain after single skip
  });
});

describe('reconstructDocument', () => {
  it('returns content unchanged when frontmatter is null', () => {
    expect(reconstructDocument(null, 'Hello')).toBe('Hello');
  });

  it('does not duplicate frontmatter when already present', () => {
    const raw = `---\ntitle: T\n---`;
    const content = raw + '\nBody';
    const fm = { raw, content: { title: 'T' } } as any;
    expect(reconstructDocument(fm, content)).toBe(content);
  });

  it('prepends frontmatter.raw when missing from content', () => {
    const raw = `---\ntitle: T\n---`;
    const content = 'Body';
    const fm = { raw, content: { title: 'T' } } as any;
    expect(reconstructDocument(fm, content)).toBe(raw + '\n' + content);
  });
});

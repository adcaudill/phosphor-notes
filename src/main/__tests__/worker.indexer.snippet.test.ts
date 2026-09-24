import { describe, it, expect } from 'vitest';
import { queryTokens, stripFrontmatter } from '../worker/indexer';

describe('queryTokens', () => {
  it('splits a compound query like an email address into its component tokens', () => {
    expect(queryTokens('jon@iomergent.com')).toEqual(['jon', 'iomergent', 'com']);
  });

  it('lowercases and drops empty tokens', () => {
    expect(queryTokens('  Hello,   World!! ')).toEqual(['hello', 'world']);
  });

  it('returns an empty array for a query with no word characters', () => {
    expect(queryTokens('@@@')).toEqual([]);
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading frontmatter block and the delimiter lines themselves', () => {
    const content = '---\ntitle: X\ntags: [a, b]\n---\nActual body text.\nMore body.';
    expect(stripFrontmatter(content)).toBe('Actual body text.\nMore body.');
  });

  it('leaves content with no frontmatter untouched', () => {
    expect(stripFrontmatter('Just plain text.')).toBe('Just plain text.');
  });

  it('does not strip a "---" that appears later in the body (e.g. a markdown rule)', () => {
    const content = '---\ntitle: X\n---\nIntro.\n\n---\n\nMore.';
    expect(stripFrontmatter(content)).toBe('Intro.\n\n---\n\nMore.');
  });
});

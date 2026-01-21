import { describe, it, expect } from 'vitest';
import { extractWikilinks } from '../wikilinks';

describe('extractWikilinks', () => {
  it('treats dotted names as markdown pages', () => {
    const links = extractWikilinks('See [[example.com]] for details');
    expect(links).toContain('example.com.md');
  });

  it('skips known attachment extensions (case-insensitive)', () => {
    expect(extractWikilinks('Embedded ![[image.png]]')).toHaveLength(0);
    expect(extractWikilinks('Image link [[photo.PNG]]')).toHaveLength(0);
  });

  it('keeps explicit .md targets intact', () => {
    const links = extractWikilinks('Reference [[note.md]]');
    expect(links).toContain('note.md');
  });

  it('handles aliases and headings by stripping them', () => {
    expect(extractWikilinks('Alias [[example.com|Alias Text]]')).toContain('example.com.md');
    expect(extractWikilinks('Heading [[example.com#Section]]')).toContain('example.com.md');
  });

  it('adds implicit parent links for nested paths', () => {
    const links = extractWikilinks('See [[People/John]]');
    expect(links).toContain('People/John.md');
    expect(links).toContain('People.md');
  });

  it('does not double-append .md when already present (with dots)', () => {
    const links = extractWikilinks('Reference [[example.com.md]]');
    expect(links).toContain('example.com.md');
  });
});

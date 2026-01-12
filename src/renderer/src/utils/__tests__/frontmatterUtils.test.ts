import {
  extractFrontmatter,
  isDailyNote,
  extractDateFromFilename,
  generateDefaultFrontmatter
} from '../frontmatterUtils';

describe('extractFrontmatter', () => {
  it('should extract frontmatter and content correctly', () => {
    const doc = `---
title: Test
date: 2026-01-12
---
This is the content.
It has multiple lines.`;

    const result = extractFrontmatter(doc);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.raw).toBe(`---
title: Test
date: 2026-01-12
---`);
    expect(result.content).toBe('This is the content.\nIt has multiple lines.');
  });

  it('should handle documents without frontmatter', () => {
    const doc = `Just some content
without frontmatter`;

    const result = extractFrontmatter(doc);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(doc);
  });

  it('should handle documents with malformed frontmatter', () => {
    const doc = `---
title: Test
This is missing closing delimiter`;

    const result = extractFrontmatter(doc);

    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(doc);
  });
});

describe('isDailyNote', () => {
  it('should identify daily note filenames', () => {
    expect(isDailyNote('2026-01-12.md')).toBe(true);
    expect(isDailyNote('2025-12-25.md')).toBe(true);
    expect(isDailyNote('2024-02-29.md')).toBe(true);
  });

  it('should reject non-daily-note filenames', () => {
    expect(isDailyNote('my-note.md')).toBe(false);
    expect(isDailyNote('2026-1-12.md')).toBe(false);
    expect(isDailyNote('2026-01-12')).toBe(false);
    expect(isDailyNote('note.txt')).toBe(false);
  });
});

describe('extractDateFromFilename', () => {
  it('should extract date from daily note filename', () => {
    const date = extractDateFromFilename('2026-01-12.md');
    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(0); // January
    expect(date?.getDate()).toBe(12);
  });

  it('should return null for non-daily-note filenames', () => {
    expect(extractDateFromFilename('my-note.md')).toBeNull();
    expect(extractDateFromFilename('note.txt')).toBeNull();
  });
});

describe('generateDefaultFrontmatter', () => {
  it('should generate daily note frontmatter with formatted date', () => {
    const frontmatter = generateDefaultFrontmatter('2026-01-12.md');
    expect(frontmatter).toContain('title: January 12, 2026');
    expect(frontmatter).toContain('type: daily');
    expect(frontmatter).toContain('---');
  });

  it('should generate default frontmatter for non-daily notes with filename as title', () => {
    const frontmatter = generateDefaultFrontmatter('Ideas.md');
    expect(frontmatter).toContain('title: Ideas');
    expect(frontmatter).toContain('---');
    expect(frontmatter).not.toContain('type: daily');
  });

  it('should strip .md extension from filename title', () => {
    const frontmatter = generateDefaultFrontmatter('My-Note.md');
    expect(frontmatter).toContain('title: My-Note');
    expect(frontmatter).not.toContain('.md');
  });
});

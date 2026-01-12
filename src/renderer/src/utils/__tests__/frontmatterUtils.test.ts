import { extractFrontmatter } from '../frontmatterUtils';

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

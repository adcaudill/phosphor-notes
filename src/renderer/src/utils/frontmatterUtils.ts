export interface Frontmatter {
  raw: string;
  content: Record<string, unknown>;
}

export interface DocumentParts {
  frontmatter: Frontmatter | null;
  content: string;
}

/**
 * Check if a filename matches the daily note pattern (YYYY-MM-DD.md)
 */
export function isDailyNote(filename: string): boolean {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})\.md$/);
  return !!match;
}

/**
 * Extract date parts from a daily note filename
 */
export function extractDateFromFilename(filename: string): Date | null {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (!match) return null;

  const [, year, month, day] = match;
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

/**
 * Generate default frontmatter for a new file
 */
export function generateDefaultFrontmatter(
  filename: string,
  mode?: 'freeform' | 'outliner'
): string {
  if (isDailyNote(filename)) {
    const date = extractDateFromFilename(filename);
    if (date) {
      const formatted = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const modeStr = mode ? `\nmode: ${mode}` : '';
      return `---\ntitle: ${formatted}\ntype: daily${modeStr}\n---`;
    }
  }

  // Extract filename without extension for default title
  const filenameWithoutExt = filename.replace(/\.md$/, '');
  return `---\ntitle: ${filenameWithoutExt}\n---`;
}

/**
 * Extract frontmatter from a document string
 * Frontmatter is expected to be at the start, between --- delimiters
 */
export function extractFrontmatter(docString: string): DocumentParts {
  if (!docString.startsWith('---')) {
    return {
      frontmatter: null,
      content: docString
    };
  }

  // Find the closing --- delimiter
  const endMatch = docString.indexOf('\n---', 3);
  if (endMatch === -1) {
    return {
      frontmatter: null,
      content: docString
    };
  }

  // endMatch is the position of the \n before the closing ---
  // So we include from start to after the closing --- (endMatch + 4)
  const rawFrontmatter = docString.slice(0, endMatch + 4);

  // Skip the closing --- and any following newlines
  // endMatch + 4 is right after ---, so we need to skip the \n after it if present
  let contentStart = endMatch + 4;
  if (docString[contentStart] === '\n') {
    contentStart += 1;
  }
  const content = docString.slice(contentStart);

  return {
    frontmatter: {
      raw: rawFrontmatter,
      content: parseFrontmatter(rawFrontmatter)
    },
    content
  };
}

/**
 * Parse YAML-like frontmatter into key-value pairs
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const lines = raw.split('\n').slice(1, -1); // Remove --- delimiters
  const result: Record<string, unknown> = {};

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      result[key] = value.trim();
    }
  }

  return result;
}

/**
 * Reconstruct a document with frontmatter and content
 * Only adds frontmatter if it's not already present in the content
 */
export function reconstructDocument(frontmatter: Frontmatter | null, content: string): string {
  if (!frontmatter) {
    return content;
  }

  // Check if the content already starts with this frontmatter (avoid duplication)
  if (content.startsWith(frontmatter.raw)) {
    // Content already has frontmatter, return as-is
    return content;
  }

  // Use the raw frontmatter if available to preserve exact formatting
  return frontmatter.raw + '\n' + content;
}

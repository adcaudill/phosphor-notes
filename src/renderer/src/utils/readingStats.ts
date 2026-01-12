/**
 * Reading Stats Utility
 *
 * Calculates word count, character count, and estimated read time
 * for markdown content.
 */

export interface ReadingStats {
  wordCount: number;
  charCount: number;
  readTimeMinutes: number;
  readTimeSeconds: number;
}

/**
 * Extract content without frontmatter for accurate stats
 */
function extractContent(doc: string): string {
  // Remove frontmatter if present
  const frontmatterMatch = doc.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatterMatch) {
    return doc.slice(frontmatterMatch[0].length);
  }
  return doc;
}

/**
 * Calculate reading statistics for document content
 *
 * @param doc - Full document content (including frontmatter)
 * @returns Reading stats object with word count, char count, and read time
 */
export function calculateReadingStats(doc: string): ReadingStats {
  // Extract only the content portion (skip frontmatter)
  const content = extractContent(doc);

  if (!content.trim()) {
    return {
      wordCount: 0,
      charCount: 0,
      readTimeMinutes: 0,
      readTimeSeconds: 0
    };
  }

  // Count characters (including spaces, punctuation, etc.)
  const charCount = content.length;

  // Count words: split by whitespace and filter empty strings
  // This handles multiple spaces and newlines correctly
  const wordCount = content.trim().split(/\s+/).length;

  // Calculate read time: average reading speed is 225 words per minute
  const totalSeconds = Math.ceil((wordCount / 225) * 60);
  const readTimeMinutes = Math.floor(totalSeconds / 60);
  const readTimeSeconds = totalSeconds % 60;

  return {
    wordCount,
    charCount,
    readTimeMinutes,
    readTimeSeconds
  };
}

/**
 * Format reading time for display
 *
 * @param stats - Reading stats object
 * @returns Formatted string like "2 min read" or "45 sec read"
 */
export function formatReadTime(stats: ReadingStats): string {
  if (stats.readTimeMinutes > 0) {
    return `${stats.readTimeMinutes} min read`;
  }
  return `${stats.readTimeSeconds} sec read`;
}

/**
 * Format word count for display
 */
export function formatWordCount(wordCount: number): string {
  return `${wordCount.toLocaleString()} word${wordCount !== 1 ? 's' : ''}`;
}

/**
 * Format character count for display
 */
export function formatCharCount(charCount: number): string {
  return `${charCount.toLocaleString()} char${charCount !== 1 ? 's' : ''}`;
}

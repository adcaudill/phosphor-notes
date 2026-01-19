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

function lexiconCount(doc: string): number {
  const uniqueWords = new Set<string>();

  const words = doc
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\w']/g, '')) // Remove punctuation
    .filter((word) => word.length > 0); // Filter out empty strings

  for (const word of words) {
    uniqueWords.add(word);
  }

  return uniqueWords.size;
}

/**
 * Extract sentences from content, ignoring frontmatter
 */
function extractSentences(doc: string): string[] {
  const content = extractContent(doc);

  const validSentences: string[] = [];
  const sentences = content.split(/ *[.?!]['")\]]*[ |\n](?=[A-Z])/g);

  for (const sentence of sentences) {
    if (!(lexiconCount(sentence) <= 2)) {
      validSentences.push(sentence);
    }
  }

  return validSentences;
}

/**
 * Calculate average sentence length in words
 */
export function calculateSentenceAvgLength(doc: string): number {
  const sentences = extractSentences(doc);
  if (sentences.length === 0) return 0;

  const totalWords = sentences.reduce((sum, sentence) => {
    const wordCount = sentence.trim().split(/\s+/).length;
    return sum + wordCount;
  }, 0);

  return totalWords / sentences.length;
}

export function calculateSentenceLongCount(doc: string): number {
  const sentences = extractSentences(doc);
  let longSentenceCount = 0;

  for (const sentence of sentences) {
    const wordCount = sentence.trim().split(/\s+/).length;
    if (wordCount > 20) {
      longSentenceCount++;
    }
  }

  return longSentenceCount;
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

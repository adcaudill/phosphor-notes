/**
 * Reading Stats Utility
 *
 * Calculates word count, character count, and estimated read time
 * for markdown content.
 */

import { removeStopwords } from 'stopword';
import { syllable } from 'syllable';

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
    doc = doc.slice(frontmatterMatch[0].length);
  }
  // At this point `doc` contains the main content. We'll strip common
  // Markdown constructs so downstream stats operate on plain text.

  // Remove code fences (```...```) and their contents
  doc = doc.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code `...`
  doc = doc.replace(/`[^`]*`/g, ' ');
  // Replace images ![alt](url) with alt text
  doc = doc.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Replace markdown links [text](url) with text
  doc = doc.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Replace wiki-links [[Page|Text]] -> Text or [[Page]] -> Page
  doc = doc.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, p1, p2) => p2 || p1);
  // Remove emphasis markers (*, _, **, __, ~~)
  doc = doc.replace(/\*\*|__|\*|_|~~/g, '');
  // Remove HTML tags
  doc = doc.replace(/<[^>]+>/g, ' ');
  // Remove list markers ( -, *, +, numbered lists ) at line starts
  doc = doc.replace(/^\s*[-*+]\s+/gm, ' ');
  doc = doc.replace(/^\s*\d+\.\s+/gm, ' ');
  // Remove blockquote markers
  doc = doc.replace(/^>\s+/gm, ' ');
  // Remove table separators |----
  doc = doc.replace(/\|/g, ' ');
  // Remove plaintext URLs (http(s)://... and www....)
  doc = doc.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');

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
 * Extract paragraphs from content, ignoring frontmatter
 */
function extractParagraphs(doc: string): string[] {
  const content = extractContent(doc);
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim());
  return paragraphs.filter((p) => p.length > 0);
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

/**
 * Calculate count of long sentences (>20 words)
 */
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
 * Calculate average paragraph length in words
 */
export function calculateParagraphAvgLength(doc: string): number {
  const paragraphs = extractParagraphs(doc);
  if (paragraphs.length === 0) return 0;

  const totalWords = paragraphs.reduce((sum, paragraph) => {
    const wordCount = paragraph.trim().split(/\s+/).length;
    return sum + wordCount;
  }, 0);

  return totalWords / paragraphs.length;
}

/**
 * Calculate top N most frequent words in the document
 */
export function calculateTopWords(
  doc: string,
  topN: number = 5
): { word: string; count: number }[] {
  const content = extractContent(doc).toLowerCase();
  const words = content
    .split(/\s+/)
    .map((word) => word.replace(/[^\w']/g, '')) // Remove punctuation
    .filter((word) => word.length > 0); // Filter out empty strings

  const filteredWords = removeStopwords(words);

  const wordCountMap: Record<string, number> = {};

  for (const word of filteredWords) {
    wordCountMap[word] = (wordCountMap[word] || 0) + 1;
  }

  const sortedWords = Object.entries(wordCountMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));

  return sortedWords;
}

/** C
 * alculate percentage of complex words (3+ syllables)
 */
export function calculatePercentComplexWords(doc: string): number {
  const content = extractContent(doc);
  const words = content
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\w']/g, '')) // Remove punctuation
    .filter((word) => word.length > 0); // Filter out empty strings

  if (words.length === 0) return 0;

  let complexWordCount = 0;

  for (const word of words) {
    if (syllable(word) >= 3) {
      complexWordCount++;
    }
  }

  return (complexWordCount / words.length) * 100;
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

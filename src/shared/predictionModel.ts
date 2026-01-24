export interface SerializedSuggestion {
  w: string; // word
  c: number; // count
}

export interface SerializedTrieNode {
  children?: Record<string, SerializedTrieNode>;
  top?: SerializedSuggestion[];
}

export interface PredictionModelSnapshot {
  version: 1;
  updatedAt: number;
  tokenCount: number;
  uniqueTokens: number;
  trie: SerializedTrieNode;
  bigrams: Record<string, SerializedSuggestion[]>;
  trigrams: Record<string, SerializedSuggestion[]>; // key: "word1 word2"
}

export interface TrainOptions {
  maxTopPerPrefix?: number;
  maxBigramPerWord?: number;
  minBigramCount?: number;
  maxTrigramPerKey?: number;
  minTrigramCount?: number;
  minWordLength?: number;
}

const DEFAULT_MAX_TOP = 10;
const DEFAULT_MAX_BIGRAM = 10;
const DEFAULT_MIN_BIGRAM_COUNT = 2;
const DEFAULT_MAX_TRIGRAM = 15;
const DEFAULT_MIN_TRIGRAM_COUNT = 2;
const MAX_WORD_LENGTH = 64; // avoid pathological trie depth from extremely long tokens

export interface TokenizeOptions {
  minWordLength?: number;
}

export function tokenizeText(text: string, opts: TokenizeOptions = {}): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9'][a-z0-9'-]*/gi);
  if (!matches) return [];
  const minLen = opts.minWordLength ?? 0;
  return matches
    .map((w) => (w.length > MAX_WORD_LENGTH ? w.slice(0, MAX_WORD_LENGTH) : w))
    .filter((w) => w.length >= minLen);
}

export function buildSnapshotFromCounts(
  wordCounts: Map<string, number>,
  bigramCounts: Map<string, Map<string, number>>,
  trigramCounts: Map<string, Map<string, number>>,
  tokenCount: number,
  options: TrainOptions = {}
): PredictionModelSnapshot {
  const maxTop = options.maxTopPerPrefix ?? DEFAULT_MAX_TOP;
  const maxBigram = options.maxBigramPerWord ?? DEFAULT_MAX_BIGRAM;
  const minBigramCount = options.minBigramCount ?? DEFAULT_MIN_BIGRAM_COUNT;
  const maxTrigram = options.maxTrigramPerKey ?? DEFAULT_MAX_TRIGRAM;
  const minTrigramCount = options.minTrigramCount ?? DEFAULT_MIN_TRIGRAM_COUNT;

  const root: SerializedTrieNode = {};

  for (const [word, count] of wordCounts.entries()) {
    insertIntoTrie(root, word, count, maxTop);
  }

  const bigrams: Record<string, SerializedSuggestion[]> = {};
  for (const [word, nextMap] of bigramCounts.entries()) {
    const ranked = Array.from(nextMap.entries())
      .map(([w, c]) => ({ w, c }))
      .filter((entry) => entry.c >= minBigramCount)
      .sort((a, b) => b.c - a.c || (a.w < b.w ? -1 : 1))
      .slice(0, maxBigram);
    if (ranked.length > 0) {
      bigrams[word] = ranked;
    }
  }

  const trigrams: Record<string, SerializedSuggestion[]> = {};
  for (const [key, nextMap] of trigramCounts.entries()) {
    const ranked = Array.from(nextMap.entries())
      .map(([w, c]) => ({ w, c }))
      .filter((entry) => entry.c >= minTrigramCount)
      .sort((a, b) => b.c - a.c || (a.w < b.w ? -1 : 1))
      .slice(0, maxTrigram);
    if (ranked.length > 0) {
      trigrams[key] = ranked;
    }
  }

  return {
    version: 1,
    updatedAt: Date.now(),
    tokenCount,
    uniqueTokens: wordCounts.size,
    trie: root,
    bigrams,
    trigrams
  };
}

function insertIntoTrie(
  root: SerializedTrieNode,
  word: string,
  count: number,
  maxTop: number
): void {
  let node = root;
  for (const ch of word) {
    if (!node.children) node.children = {};
    node.children[ch] = node.children[ch] ?? {};
    node = node.children[ch];
    node.top = updateTopList(node.top ?? [], word, count, maxTop);
  }
  node.top = updateTopList(node.top ?? [], word, count, maxTop);
}

function updateTopList(
  list: SerializedSuggestion[],
  word: string,
  count: number,
  maxTop: number
): SerializedSuggestion[] {
  const existing = list.find((entry) => entry.w === word);
  if (existing) {
    existing.c = count;
  } else {
    list.push({ w: word, c: count });
  }

  list.sort((a, b) => b.c - a.c || (a.w < b.w ? -1 : 1));
  return list.slice(0, maxTop);
}

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
}

export interface TrainOptions {
  maxTopPerPrefix?: number;
  maxBigramPerWord?: number;
  minBigramCount?: number;
  minWordLength?: number;
}

const DEFAULT_MAX_TOP = 3;
const DEFAULT_MAX_BIGRAM = 5;
const DEFAULT_MIN_BIGRAM_COUNT = 2;
const DEFAULT_MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 64; // avoid pathological trie depth from extremely long tokens

export function trainPredictionModel(
  texts: string[],
  options: TrainOptions = {}
): PredictionModelSnapshot {
  const maxTop = options.maxTopPerPrefix ?? DEFAULT_MAX_TOP;
  const maxBigram = options.maxBigramPerWord ?? DEFAULT_MAX_BIGRAM;
  const minBigramCount = options.minBigramCount ?? DEFAULT_MIN_BIGRAM_COUNT;
  const minWordLength = options.minWordLength ?? DEFAULT_MIN_WORD_LENGTH;

  const root: SerializedTrieNode = {};
  const wordCounts = new Map<string, number>();
  const bigramCounts = new Map<string, Map<string, number>>();

  let tokenCount = 0;

  for (const text of texts) {
    const tokens = tokenize(text).filter((w) => w.length >= minWordLength);
    if (tokens.length === 0) continue;
    tokenCount += tokens.length;

    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i];
      const nextWord = tokens[i + 1];

      const newCount = (wordCounts.get(word) ?? 0) + 1;
      wordCounts.set(word, newCount);
      insertIntoTrie(root, word, newCount, maxTop);

      if (nextWord) {
        let nextMap = bigramCounts.get(word);
        if (!nextMap) {
          nextMap = new Map<string, number>();
          bigramCounts.set(word, nextMap);
        }
        nextMap.set(nextWord, (nextMap.get(nextWord) ?? 0) + 1);
      }
    }
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

  return {
    version: 1,
    updatedAt: Date.now(),
    tokenCount,
    uniqueTokens: wordCounts.size,
    trie: root,
    bigrams
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

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9'][a-z0-9'-]*/gi);
  if (!matches) return [];
  return matches.map((w) => (w.length > MAX_WORD_LENGTH ? w.slice(0, MAX_WORD_LENGTH) : w));
}

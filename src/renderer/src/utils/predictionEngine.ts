import { brill } from 'brill';
import type { PredictionModelSnapshot, SerializedTrieNode } from '../../../shared/predictionModel';

interface PredictionOptions {
  minPrefixLength?: number;
  minNextProb?: number;
  minNextCount?: number;
}

interface BestNext {
  word: string;
  prob: number;
  count: number;
}

export class PredictionEngine {
  private readonly minPrefix: number;
  private readonly minNextProb: number;
  private readonly minNextCount: number;

  constructor(
    private readonly snapshot: PredictionModelSnapshot,
    opts: PredictionOptions = {}
  ) {
    this.minPrefix = opts.minPrefixLength ?? 2;
    this.minNextProb = opts.minNextProb ?? 0.25;
    this.minNextCount = opts.minNextCount ?? 2;
  }

  predictCompletion(prefix: string, context?: string | null): string | null {
    if (!prefix || prefix.length < this.minPrefix) return null;
    const lowerPrefix = prefix.toLowerCase();
    const node = this.findNode(lowerPrefix);
    if (!node || !node.top || node.top.length === 0) return null;

    const contextTokens = this.tokenizeContext(context);
    const { prevWord, prevPrev } = this.extractPrevWords(contextTokens, lowerPrefix);

    const total = node.top.reduce((acc, curr) => acc + (curr.c || 0), 0);
    let best: (typeof node.top)[0] | null = null;
    let bestScore = -1;

    for (const cand of node.top) {
      if (!cand.w.startsWith(lowerPrefix)) continue;
      if (cand.w === lowerPrefix) continue;
      if (cand.w === `${lowerPrefix}s` || cand.w === `${lowerPrefix}es`) continue;

      const baseProb = total > 0 ? (cand.c || 0) / total : 0;
      const weight = this.computePosWeight(cand.w, prevWord, prevPrev, contextTokens);
      const score = baseProb * weight;

      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    if (!best || best.w === lowerPrefix) return null;

    const suffixLen = best.w.length - lowerPrefix.length;
    if (suffixLen <= 2) return null; // skip trivial completions (1–2 chars)
    if (suffixLen > 32) return null; // avoid absurdly long completions

    return best.w;
  }

  predictNext(prevWord: string, prevPrev?: string | null, context?: string | null): string | null {
    if (!prevWord) return null;

    const trigramKey = prevPrev ? `${prevPrev.toLowerCase()} ${prevWord.toLowerCase()}` : null;
    const trigramCandidates = trigramKey ? this.snapshot.trigrams[trigramKey] : undefined;
    const candidates =
      trigramCandidates && trigramCandidates.length > 0
        ? trigramCandidates
        : this.snapshot.bigrams[prevWord.toLowerCase()];

    if (!candidates || candidates.length === 0) return null;

    const contextTokens = this.tokenizeContext(context);
    const best = this.pickBestNext(candidates, prevWord, prevPrev ?? null, contextTokens);

    if (!best) return null;
    if (best.count < this.minNextCount) return null;
    if (best.prob < this.minNextProb) return null;

    return best.word;
  }

  private pickBestNext(
    list: { w: string; c: number }[],
    prevWord: string,
    prevPrev: string | null,
    contextTokens: string[]
  ): BestNext | null {
    if (!list.length) return null;
    const total = list.reduce((acc, curr) => acc + curr.c, 0);
    let bestCandidate: { w: string; c: number } | null = null;
    let bestScore = -1;
    for (const cand of list) {
      const baseProb = total > 0 ? cand.c / total : 0;
      const weight = this.computePosWeight(cand.w, prevWord, prevPrev, contextTokens);
      const score = baseProb * weight;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = cand;
      }
    }

    if (!bestCandidate) return null;
    return {
      word: bestCandidate.w,
      count: bestCandidate.c,
      prob: total > 0 ? bestCandidate.c / total : 0
    };
  }

  private computePosWeight(
    candidate: string,
    prevWord: string,
    prevPrev: string | null,
    contextTokens: string[]
  ): number {
    const tags = this.getTags(candidate);
    if (tags.length === 0) return 1;

    const expectation = this.expectedPos(prevWord, prevPrev, contextTokens);
    const hasVerb = tags.some((t) => t.startsWith('VB'));
    const hasNoun = tags.some((t) => t.startsWith('NN'));
    const hasAdj = tags.some((t) => t.startsWith('JJ'));
    const hasAdv = tags.some((t) => t.startsWith('RB'));

    switch (expectation) {
      case 'verb':
        if (hasVerb) return 1.3;
        if (hasNoun) return 0.85;
        return 0.7;
      case 'noun':
        if (hasNoun) return 1.3;
        if (hasAdj) return 1.05;
        if (hasVerb) return 0.85;
        return 0.8;
      case 'adj':
        if (hasAdj) return 1.25;
        if (hasNoun) return 0.95;
        return 0.75;
      case 'adv':
        if (hasAdv) return 1.2;
        if (hasVerb) return 1.05;
        return 0.85;
      default:
        return 1;
    }
  }

  private expectedPos(
    prevWord: string,
    prevPrev: string | null,
    contextTokens: string[]
  ): 'verb' | 'noun' | 'adj' | 'adv' | null {
    const w = (prevWord || '').toLowerCase();
    const prior = (prevPrev || '').toLowerCase();

    const determiners = new Set([
      'a',
      'an',
      'the',
      'this',
      'that',
      'these',
      'those',
      'my',
      'your',
      'his',
      'her',
      'our',
      'their'
    ]);
    const copulas = new Set(['is', 'are', 'was', 'were', 'be', 'am', 'been']);
    const modals = new Set([
      'can',
      'could',
      'will',
      'would',
      'should',
      'shall',
      'may',
      'might',
      'must'
    ]);
    const prepositions = new Set([
      'of',
      'in',
      'on',
      'for',
      'with',
      'at',
      'by',
      'about',
      'from',
      'to'
    ]);
    const volitionVerbs = new Set(['want', 'hope', 'plan', 'expect', 'try', 'like', 'love']);

    // Edge Case: "To" Logic
    if (w === 'to') {
      // "Want to [go]" (Verb) vs "Walk to [School]" (Noun)
      if (volitionVerbs.has(prior)) return 'verb';
      return 'noun';
    }

    if (determiners.has(w)) return 'noun'; // "The [Cat]" (or Adj, but Noun is the head)
    if (modals.has(w)) return 'verb'; // "Can [Go]"
    if (prepositions.has(w)) return 'noun'; // "In [Space]"
    if (copulas.has(w)) return 'adj'; // "Is [Red]"

    // Deep context scan (Noun Phrase Detection)
    // Scan backwards from n-2 to find the start of the phrase (Determiner).
    const limit = Math.max(0, contextTokens.length - 6);
    let seenAdjectives = false;
    let seenAdverb = false;

    // Start loop at length-2 because length-1 is 'prevWord' (w) which we already checked
    for (let i = contextTokens.length - 2; i >= limit; i--) {
      const token = contextTokens[i];

      // STOPPERS: These break a Noun Phrase chain
      if (['that', 'which', 'who', ',', '.', ';'].includes(token)) break;
      // If we hit a Verb (that isn't a copula), the Noun Phrase definitely stopped before this
      if (this.wordHasTag(token, 'VB') && !copulas.has(token)) break;

      // SIGNAL: We hit the start of a Noun Phrase
      if (determiners.has(token)) {
        // Logic: We are inside a Noun Phrase (Determiner ... Cursor).

        // If the word immediately before cursor is an Adjective, a Noun is heavily expected.
        // Ex: "The red [Ball]"
        if (this.wordHasTag(w, 'JJ')) return 'noun';

        // If we saw Adverbs/Adjectives in the chain, we are building up to a Noun.
        // Ex: "The very red [Car]"
        if (seenAdjectives || seenAdverb) return 'noun';

        // If we have seen nothing but the Determiner and the current word,
        // it's ambiguous, but 'noun' remains the safest prediction for completion weighting.
        return 'noun';
      }

      // Track what we see as we walk backwards
      if (this.wordHasTag(token, 'JJ')) seenAdjectives = true;
      if (this.wordHasTag(token, 'RB')) seenAdverb = true;
    }

    // Two-Word Heuristics
    if (prior) {
      // "Very [Adj] [Noun]" pattern
      // Ex: "Very fast [Car]"
      if (this.wordHasTag(prior, 'RB') && this.wordHasTag(w, 'JJ')) return 'noun';

      // "More [Noun] [Noun]" or "More [Adj] [Noun]"
      if (prior === 'more' || prior === 'most') return 'noun';
    }

    // Single-Word Heuristics
    if (this.wordHasTag(w, 'JJ')) return 'noun'; // "Red [Ball]"
    if (this.wordHasTag(w, 'NN')) return 'verb'; // "The dog [ran]"

    return null;
  }

  private wordHasTag(word: string, prefix: string): boolean {
    const tags = this.getTags(word);
    return tags.some((t) => t.startsWith(prefix));
  }

  private tokenizeContext(context?: string | null): string[] {
    if (!context) return [];
    const matches = context.toLowerCase().match(/[a-z0-9']+/g);
    return matches ?? [];
  }

  private extractPrevWords(
    contextTokens: string[],
    currentPrefix: string
  ): { prevWord: string; prevPrev: string | null } {
    if (contextTokens.length === 0) return { prevWord: '', prevPrev: null };

    const tokens = [...contextTokens];
    const last = tokens.pop() || '';
    const isCurrent = last === currentPrefix || last.startsWith(currentPrefix);

    if (isCurrent) {
      const prevWord = tokens.pop() || '';
      const prevPrev = tokens.pop() || null;
      return { prevWord, prevPrev };
    }

    const prevWord = last;
    const prevPrev = tokens.pop() || null;
    return { prevWord, prevPrev };
  }

  private getTags(word: string): string[] {
    if (!word) return [];
    return brill[word] || brill[word.toLowerCase()] || [];
  }

  private findNode(prefix: string): SerializedTrieNode | null {
    let node: SerializedTrieNode | undefined = this.snapshot.trie;
    for (const ch of prefix) {
      if (!node.children) return null;
      node = node.children[ch];
      if (!node) return null;
    }
    return node ?? null;
  }
}

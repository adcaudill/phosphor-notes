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
    if (best.w.length < 3) return null; // avoid very short completions

    if (bestScore < 0.1) return null;

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
    const w2 = (prevPrev || '').toLowerCase();
    const lastToken = contextTokens[contextTokens.length - 1] || '';
    const beforeLast = contextTokens[contextTokens.length - 2] || '';
    const prior = w2 || (beforeLast !== w ? beforeLast : '');

    const determiners = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those']);
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
    const pronouns = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'it']);
    const adverbCue = new Set(['very', 'quite', 'so', 'too', 'really']);
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

    if (w === 'to') return 'verb';
    if (prepositions.has(w)) return 'noun';
    if (determiners.has(w)) return 'noun';
    if (modals.has(w)) return 'verb';
    if (pronouns.has(w)) return 'verb';
    if (copulas.has(w)) return 'adj';
    if (adverbCue.has(w)) return 'adj';

    if (prior) {
      if (determiners.has(prior)) return 'noun';
      if (modals.has(prior)) return 'verb';
      if (copulas.has(prior)) return 'adj';
    }

    if (lastToken && lastToken !== w) {
      if (this.wordHasTag(lastToken, 'JJ')) return 'noun';
      if (this.wordHasTag(lastToken, 'RB')) return 'adj';
      if (this.wordHasTag(lastToken, 'VB')) return 'noun';
    }

    // If previous two words look like adj + noun, next may be adv/verb; keep neutral.
    if (w2 && this.wordHasTag(w2, 'JJ') && this.wordHasTag(w, 'NN')) return null;

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

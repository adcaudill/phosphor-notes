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
    const node = this.findNode(prefix.toLowerCase());
    if (!node || !node.top || node.top.length === 0) return null;
    const best = node.top[0];
    if (!best || best.w === prefix.toLowerCase()) return null;
    return best.w;
  }

  predictNext(prevWord: string, context?: string | null): string | null {
    if (!prevWord) return null;
    const candidates = this.snapshot.bigrams[prevWord.toLowerCase()];
    if (!candidates || candidates.length === 0) return null;
    const best = this.pickBestNext(candidates);
    if (!best) return null;
    if (best.count < this.minNextCount) return null;
    if (best.prob < this.minNextProb) return null;
    return best.word;
  }

  private pickBestNext(list: { w: string; c: number }[]): BestNext | null {
    if (!list.length) return null;
    const total = list.reduce((acc, curr) => acc + curr.c, 0);
    const best = list[0];
    return {
      word: best.w,
      count: best.c,
      prob: total > 0 ? best.c / total : 0
    };
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

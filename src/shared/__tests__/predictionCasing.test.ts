import { describe, expect, it } from 'vitest';
import { PredictionEngine } from '../../renderer/src/utils/predictionEngine';
import type { PredictionModelSnapshot } from '../predictionModel';

function makeEngine(snapshot: Partial<PredictionModelSnapshot>): PredictionEngine {
  const base: PredictionModelSnapshot = {
    version: 1,
    updatedAt: 0,
    tokenCount: 0,
    uniqueTokens: 0,
    trie: {},
    bigrams: {},
    trigrams: {},
    caseStats: {},
    ...snapshot
  } as PredictionModelSnapshot;

  return new PredictionEngine(base, { minNextProb: 0, minNextCount: 0 });
}

describe('PredictionEngine casing preferences', () => {
  it('promotes proper nouns mid-sentence when capitalized mid usage dominates', () => {
    const engine = makeEngine({
      bigrams: { met: [{ w: 'sam', c: 5 }] },
      caseStats: {
        sam: { lower: 1, capitalizedStart: 0, capitalizedMid: 5, upper: 0 }
      }
    });

    const result = engine.predictNext('met', 'i', 'I met ', { isSentenceStart: false });
    expect(result).toBe('Sam');
  });

  it('capitalizes at sentence start even without mid-sentence capitalized evidence', () => {
    const engine = makeEngine({
      bigrams: { after: [{ w: 'lunch', c: 3 }] },
      caseStats: {
        lunch: { lower: 10, capitalizedStart: 0, capitalizedMid: 0, upper: 0 }
      }
    });

    const result = engine.predictNext('after', undefined, '', { isSentenceStart: true });
    expect(result).toBe('Lunch');
  });

  it('preserves uppercase acronyms mid-sentence when uppercase dominates', () => {
    const engine = makeEngine({
      bigrams: { the: [{ w: 'nasa', c: 4 }] },
      caseStats: {
        nasa: { lower: 0, capitalizedStart: 0, capitalizedMid: 1, upper: 6 }
      }
    });

    const result = engine.predictNext('the', null, 'Visited the ', { isSentenceStart: false });
    expect(result).toBe('NASA');
  });

  it('sticks with lowercase when capitalized mid usage is weak', () => {
    const engine = makeEngine({
      bigrams: { on: [{ w: 'call', c: 5 }] },
      caseStats: {
        call: { lower: 8, capitalizedStart: 0, capitalizedMid: 1, upper: 0 }
      }
    });

    const result = engine.predictNext('on', null, 'We are on ', { isSentenceStart: false });
    expect(result).toBe('call');
  });
});

import { describe, it, expect } from 'vitest';
import MiniSearch from 'minisearch';

/**
 * Validates the exact assumption the search-precision fix in
 * `worker/indexer.ts` relies on: with MiniSearch's default `combineWith:
 * 'OR'`, a compound query like an email address (tokenized into several
 * independent words) matches documents that only share one token with it -
 * exactly the reported false-positive noise - while `combineWith: 'AND'`
 * (what `search_notes` now requests) requires every token to match. This
 * mirrors the app's real index config (`worker/indexer.ts`'s
 * `new MiniSearch(...)` call) rather than going through the worker-thread
 * plumbing itself.
 */
describe('search combineWith (matches the app\'s real index config)', () => {
  function buildIndex(): MiniSearch {
    const index = new MiniSearch({
      fields: ['title', 'content', 'tags'],
      storeFields: ['title', 'filename', 'tags', 'content'],
      searchOptions: {
        boost: { title: 2, tags: 1.5 },
        fuzzy: 0.2
      }
    });
    index.addAll([
      {
        id: '1',
        filename: 'People/Jon.md',
        title: 'Jon',
        content: 'Contact: jon@iomergent.com',
        tags: []
      },
      { id: '2', filename: 'Nuts.com.md', title: 'Nuts.com', content: 'A grocery order.', tags: [] },
      {
        id: '3',
        filename: 'Monday.com.md',
        title: 'Monday.com',
        content: 'Project tracker notes.',
        tags: []
      }
    ]);
    return index;
  }

  it('OR-combine (the GUI default) matches unrelated notes sharing only one token', () => {
    const index = buildIndex();
    const results = index.search('jon@iomergent.com', { prefix: true, combineWith: 'OR' });
    const filenames = results.map((r) => r.filename);
    // This is the reported bug: "Nuts.com"/"Monday.com" match on the bare
    // "com" token alone under OR-combine + prefix matching.
    expect(filenames).toEqual(expect.arrayContaining(['Nuts.com.md', 'Monday.com.md']));
  });

  it('AND-combine (what search_notes now requests) excludes single-token matches', () => {
    const index = buildIndex();
    const results = index.search('jon@iomergent.com', { prefix: true, combineWith: 'AND' });
    const filenames = results.map((r) => r.filename);
    expect(filenames).toEqual(['People/Jon.md']);
  });
});

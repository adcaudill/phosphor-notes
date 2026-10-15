import { describe, it, expect, vi, beforeEach } from 'vitest';
import MiniSearch from 'minisearch';
import { upsertSearchDoc, removeSearchDoc, type SearchEngine } from '../worker/indexer';

/**
 * The worker's full-text index used to be built once from the initial full
 * batch and never touched again, so edits, new notes, renames and deletes
 * made after startup were invisible to search (while the graph, updated
 * incrementally, stayed current). These tests cover the incremental
 * `index-file` / `remove-file` path that fixes that.
 */

function buildIndex(): SearchEngine {
  // Mirrors the app's real index config (worker/indexer.ts initSearch)
  return new MiniSearch({
    fields: ['title', 'content', 'tags'],
    storeFields: ['title', 'filename', 'tags', 'content'],
    searchOptions: { boost: { title: 2, tags: 1.5 }, fuzzy: 0.2 }
  }) as unknown as SearchEngine;
}

function filenames(engine: SearchEngine, query: string): unknown[] {
  return engine.search(query, { prefix: true, combineWith: 'AND' }).map((r) => r.filename);
}

describe('upsertSearchDoc / removeSearchDoc (real MiniSearch)', () => {
  it('adds a note that was not in the index', () => {
    const engine = buildIndex();
    upsertSearchDoc(engine, '2026-10-01.md', 'Call about Freshservice');
    expect(filenames(engine, 'Freshservice')).toEqual(['2026-10-01.md']);
  });

  it('replaces stale content so old text no longer matches and stored content is current', () => {
    const engine = buildIndex();
    upsertSearchDoc(engine, '2026-09-24.md', 'Met with [[MissionWire]] team');
    upsertSearchDoc(engine, '2026-09-24.md', 'Met with [[MissionWired]] team about Valence');

    expect(filenames(engine, 'Valence')).toEqual(['2026-09-24.md']);
    const [hit] = engine.search('MissionWired', { prefix: true, combineWith: 'AND' });
    expect(hit.content).toContain('[[MissionWired]]');
    // No duplicate documents for the same id
    expect(engine.search('team', { prefix: true })).toHaveLength(1);
  });

  it('removes a note so search no longer returns its path', () => {
    const engine = buildIndex();
    upsertSearchDoc(engine, 'MissionWire.md', 'Old company page');
    removeSearchDoc(engine, 'MissionWire.md');
    expect(filenames(engine, 'company')).toEqual([]);
  });

  it('treats removing a note that is not indexed as a no-op', () => {
    const engine = buildIndex();
    expect(() => removeSearchDoc(engine, 'missing.md')).not.toThrow();
  });

  it('re-adds a note after it was removed', () => {
    const engine = buildIndex();
    upsertSearchDoc(engine, 'a.md', 'first');
    removeSearchDoc(engine, 'a.md');
    upsertSearchDoc(engine, 'a.md', 'second');
    expect(filenames(engine, 'second')).toEqual(['a.md']);
    expect(filenames(engine, 'first')).toEqual([]);
  });
});

describe('indexer worker message handling', () => {
  type Handler = (msg: unknown) => Promise<void>;
  let handler: Handler;
  let posted: Array<Record<string, unknown>>;

  beforeEach(async () => {
    vi.resetModules();
    posted = [];
    vi.doMock('worker_threads', () => ({
      parentPort: {
        on: (_evt: string, cb: Handler) => {
          handler = cb;
        },
        postMessage: (msg: Record<string, unknown>) => posted.push(msg)
      }
    }));
    await import('../worker/indexer');
  });

  async function search(query: string): Promise<unknown[]> {
    const requestId = `r-${posted.length}`;
    await handler({ type: 'search', query, requestId, combineWith: 'AND' });
    const res = posted.find((m) => m.requestId === requestId);
    return (res?.data as Array<{ filename: string }>).map((r) => r.filename);
  }

  it('applies index-file and remove-file after the initial batch', async () => {
    await handler([{ filename: '2026-09-30.md', content: 'Morning: M3 gets Valence' }]);
    expect(await search('Freshservice')).toEqual([]);

    await handler({ type: 'index-file', filename: '2026-10-01.md', content: 'Freshservice call' });
    expect(await search('Freshservice')).toEqual(['2026-10-01.md']);

    await handler({
      type: 'index-file',
      filename: '2026-09-30.md',
      content: 'Morning: M3 gets Valence\nAfternoon: 4b report'
    });
    expect(await search('4b report')).toEqual(['2026-09-30.md']);

    await handler({ type: 'remove-file', filename: '2026-10-01.md' });
    expect(await search('Freshservice')).toEqual([]);
  });

  it('queues updates that arrive before the initial batch and replays them after it', async () => {
    await handler({ type: 'index-file', filename: 'new.md', content: 'Interop notes' });
    await handler({ type: 'remove-file', filename: 'old.md' });
    await handler([
      { filename: 'old.md', content: 'LastPass' },
      { filename: 'other.md', content: 'unrelated' }
    ]);

    expect(await search('Interop')).toEqual(['new.md']);
    expect(await search('LastPass')).toEqual([]);
  });
});

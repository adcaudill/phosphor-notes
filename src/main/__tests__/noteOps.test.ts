import { describe, it, expect, vi, beforeEach } from 'vitest';

let graph: Record<string, string[]> | null = null;

vi.mock('../indexer', () => ({
  getLastGraph: () => graph,
  updateGraphForFile: vi.fn(),
  updateGraphForChangedFile: vi.fn(),
  updateTasksForFile: vi.fn(),
  updateSearchIndexForFile: vi.fn(),
  removeFromSearchIndex: vi.fn()
}));
vi.mock('../store', () => ({
  getMRUFiles: vi.fn(async () => []),
  removeFromMRU: vi.fn(),
  updateMRU: vi.fn()
}));

import { findLinkCandidates } from '../noteOps';

describe('findLinkCandidates', () => {
  beforeEach(() => {
    graph = null;
  });

  it('returns null until the link graph exists', () => {
    expect(findLinkCandidates(['A.md'])).toBeNull();
  });

  it('finds notes linking to a moved note or to anything under it', () => {
    graph = {
      'Home.md': ['People.md', 'Other.md'],
      'Deep.md': ['People/Ghost.md'], // unresolved link under the moved folder
      'Lookalike.md': ['PeopleExtra/X.md'],
      'Unrelated.md': ['Other.md']
    };
    expect(findLinkCandidates(['People.md'])).toEqual(['Deep.md', 'Home.md']);
  });
});

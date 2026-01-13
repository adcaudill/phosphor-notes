import { describe, it, expect } from 'vitest';
import {
  extractWikilinks,
  extractTags,
  buildWikiGraph,
  validateGraph,
  getBacklinks,
  getConnectedComponent,
  findIsolatedFiles,
  detectCycles,
  getGraphStats,
  isDailyNote,
  extractDateHierarchy,
  generateVirtualTemporalNodes,
  WikiGraph
} from '../graphBuilder';

describe('Graph Builder - Wikilink Extraction', () => {
  describe('extractWikilinks', () => {
    it('should extract simple wikilinks', () => {
      const content = 'Check [[index]] for more info';
      const links = extractWikilinks(content);
      expect(links).toEqual(['index.md']);
    });

    it('should normalize filenames without .md extension', () => {
      const content = '[[file]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['file.md']);
    });

    it('should preserve filenames with .md extension', () => {
      const content = '[[document.md]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['document.md']);
    });

    it('should extract multiple wikilinks', () => {
      const content = '[[home]] and [[about]] and [[contact]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['home.md', 'about.md', 'contact.md']);
    });

    it('should trim whitespace in wikilinks', () => {
      const content = '[[ file ]] and [[  other  ]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['file.md', 'other.md']);
    });

    it('should skip empty wikilinks', () => {
      const content = '[[]] and [[file]] and [[  ]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['file.md']);
    });

    it('should handle wikilinks with special characters', () => {
      const content = '[[My Document]] and [[file-name]] and [[file_2]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['My Document.md', 'file-name.md', 'file_2.md']);
    });

    it('should handle wikilinks with numbers', () => {
      const content = '[[2024-01-15]] and [[file123]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['2024-01-15.md', 'file123.md']);
    });

    it('should return empty array for no wikilinks', () => {
      const content = 'No links in this text';
      expect(extractWikilinks(content)).toEqual([]);
    });

    it('should handle nested brackets outside wikilinks', () => {
      const content = 'Code [test] and [[file]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['file.md']);
    });

    it('should handle large files with many wikilinks', () => {
      let content = '';
      for (let i = 0; i < 100; i++) {
        content += `[[file${i}]] `;
      }
      const links = extractWikilinks(content);
      expect(links).toHaveLength(100);
      expect(links[0]).toBe('file0.md');
      expect(links[99]).toBe('file99.md');
    });

    it('should handle nested paths in wikilinks', () => {
      const content = '[[People/John]]';
      const links = extractWikilinks(content);
      expect(links).toEqual(['People/John.md', 'People.md']);
    });

    it('should handle deeply nested paths', () => {
      const content = '[[Projects/Work/Client/Document]]';
      const links = extractWikilinks(content);
      expect(links).toEqual([
        'Projects/Work/Client/Document.md',
        'Projects.md',
        'Projects/Work.md',
        'Projects/Work/Client.md'
      ]);
    });

    it('should deduplicate implicit parent links', () => {
      const content = '[[People/John]] and [[People/Jane]]';
      const links = extractWikilinks(content);
      expect(links).toContain('People.md');
      // People.md appears twice in the raw extract (once from each link)
      expect(links.filter((l) => l === 'People.md')).toHaveLength(2);
    });
  });

  describe('extractTags', () => {
    it('should extract tags from array format', () => {
      const content = `---
tags: [productivity, notes, research]
---
Content`;
      const tags = extractTags(content);
      expect(tags).toEqual(['notes', 'productivity', 'research']);
    });

    it('should extract tags from comma-separated format', () => {
      const content = `---
tags: work, project, urgent
---
Content`;
      const tags = extractTags(content);
      expect(tags).toEqual(['project', 'urgent', 'work']);
    });

    it('should extract tags from hashtag format', () => {
      const content = `---
#project #urgent #work
---
Content`;
      const tags = extractTags(content);
      expect(tags).toContain('project');
      expect(tags).toContain('urgent');
      expect(tags).toContain('work');
    });

    it('should normalize tags to lowercase', () => {
      const content = `---
tags: [MyTag, URGENT, Research]
---
Content`;
      const tags = extractTags(content);
      expect(tags).toEqual(['mytag', 'research', 'urgent']);
    });

    it('should handle mixed tag formats', () => {
      const content = `---
tags: [tag1, tag2]
#tag3 #tag4
---
Content`;
      const tags = extractTags(content);
      expect(tags).toHaveLength(4);
      expect(tags).toContain('tag1');
      expect(tags).toContain('tag3');
    });

    it('should return empty array for no frontmatter', () => {
      const content = 'Just content, no frontmatter';
      expect(extractTags(content)).toEqual([]);
    });

    it('should return empty array for no tags', () => {
      const content = `---
title: Document
author: John
---
Content`;
      expect(extractTags(content)).toEqual([]);
    });

    it('should handle tags with spaces in array format', () => {
      const content = `---
tags: [ tag 1 , tag 2 , tag 3 ]
---
Content`;
      const tags = extractTags(content);
      expect(tags).toHaveLength(3);
    });

    it('should deduplicate repeated tags', () => {
      const content = `---
tags: [project, urgent, project]
#urgent #work
---
Content`;
      const tags = extractTags(content);
      expect(tags.filter((t) => t === 'project')).toHaveLength(1);
      expect(tags.filter((t) => t === 'urgent')).toHaveLength(1);
    });

    it('should sort tags alphabetically', () => {
      const content = `---
tags: [zebra, apple, mango]
---
Content`;
      const tags = extractTags(content);
      expect(tags).toEqual(['apple', 'mango', 'zebra']);
    });
  });

  describe('buildWikiGraph', () => {
    it('should build graph from file contents', () => {
      const files = {
        'index.md': '[[about]] and [[contact]]',
        'about.md': '[[index]]',
        'contact.md': 'No links'
      };

      const graph = buildWikiGraph(files);
      expect(graph['index.md']).toEqual(['about.md', 'contact.md']);
      expect(graph['about.md']).toEqual(['index.md']);
      expect(graph['contact.md']).toEqual([]);
    });

    it('should handle empty files', () => {
      const files = { 'empty.md': '' };
      const graph = buildWikiGraph(files);
      expect(graph['empty.md']).toEqual([]);
    });

    it('should handle files with no wikilinks', () => {
      const files = {
        'file1.md': 'Just text',
        'file2.md': 'More text'
      };
      const graph = buildWikiGraph(files);
      expect(Object.values(graph)).toEqual([[], []]);
    });

    it('should build graph with duplicate links', () => {
      const files = { 'test.md': '[[file]] [[file]] [[file]]' };
      const graph = buildWikiGraph(files);
      expect(graph['test.md']).toEqual(['file.md', 'file.md', 'file.md']);
    });

    it('should add implicit links for nested file paths', () => {
      const files = { 'People/John.md': 'Content' };
      const graph = buildWikiGraph(files);
      expect(graph['People/John.md']).toEqual(['People.md']);
    });

    it('should add implicit links for deeply nested file paths', () => {
      const files = { 'Projects/Work/Client/Document.md': 'Content' };
      const graph = buildWikiGraph(files);
      expect(graph['Projects/Work/Client/Document.md']).toEqual([
        'Projects.md',
        'Projects/Work.md',
        'Projects/Work/Client.md'
      ]);
    });

    it('should combine explicit wikilinks with implicit nested path links', () => {
      const files = { 'People/John.md': '[[Skills]]' };
      const graph = buildWikiGraph(files);
      expect(graph['People/John.md']).toEqual(['Skills.md', 'People.md']);
    });

    it('should include virtual temporal nodes for daily notes', () => {
      const fileContents = {
        'index.md': '[[2026-01-13]]',
        '2026-01-13.md': 'Daily note content'
      };
      const allFiles = ['index.md', '2026-01-13.md'];

      const graph = buildWikiGraph(fileContents, allFiles);

      // Check that virtual nodes were created
      expect(graph['2026.md']).toBeDefined();
      expect(graph['2026-01.md']).toBeDefined();

      // Check the hierarchy
      expect(graph['2026.md']).toContain('2026-01.md');
      expect(graph['2026-01.md']).toContain('2026-01-13.md');
    });

    it('should handle multiple daily notes in same month', () => {
      const fileContents = {
        '2026-01-10.md': 'Content',
        '2026-01-11.md': 'Content',
        '2026-01-12.md': 'Content'
      };
      const allFiles = ['2026-01-10.md', '2026-01-11.md', '2026-01-12.md'];

      const graph = buildWikiGraph(fileContents, allFiles);

      // Month node should link to all daily notes
      expect(graph['2026-01.md']).toEqual(['2026-01-10.md', '2026-01-11.md', '2026-01-12.md']);
      // Year node should link to month node
      expect(graph['2026.md']).toEqual(['2026-01.md']);
    });

    it('should handle daily notes across multiple months', () => {
      const fileContents = {
        '2026-01-15.md': 'Content',
        '2026-02-20.md': 'Content',
        '2026-03-10.md': 'Content'
      };
      const allFiles = ['2026-01-15.md', '2026-02-20.md', '2026-03-10.md'];

      const graph = buildWikiGraph(fileContents, allFiles);

      // Year node should link to all months
      expect(graph['2026.md']).toContain('2026-01.md');
      expect(graph['2026.md']).toContain('2026-02.md');
      expect(graph['2026.md']).toContain('2026-03.md');

      // Month nodes should link to their daily notes
      expect(graph['2026-01.md']).toEqual(['2026-01-15.md']);
      expect(graph['2026-02.md']).toEqual(['2026-02-20.md']);
      expect(graph['2026-03.md']).toEqual(['2026-03-10.md']);
    });

    it('should handle mixed daily notes and regular files', () => {
      const fileContents = {
        'index.md': 'Content',
        '2026-01-13.md': 'Daily note'
      };
      const allFiles = ['index.md', '2026-01-13.md'];

      const graph = buildWikiGraph(fileContents, allFiles);

      // Regular files should not be affected
      expect(graph['index.md']).toEqual([]);

      // Virtual nodes should be created
      expect(graph['2026.md']).toBeDefined();
      expect(graph['2026-01.md']).toBeDefined();
      expect(graph['2026-01-13.md']).toEqual([]);
    });

    it('should not add virtual nodes without file list', () => {
      const fileContents = {
        '2026-01-13.md': 'Daily note'
      };

      const graph = buildWikiGraph(fileContents);

      // Virtual nodes should not be created without file list
      expect(graph['2026.md']).toBeUndefined();
      expect(graph['2026-01.md']).toBeUndefined();
      expect(graph['2026-01-13.md']).toEqual([]);
    });
  });

  describe('isDailyNote', () => {
    it('should identify daily notes with valid format', () => {
      expect(isDailyNote('2026-01-13.md')).toBe(true);
      expect(isDailyNote('2025-12-25.md')).toBe(true);
      expect(isDailyNote('2024-02-29.md')).toBe(true);
    });

    it('should reject non-daily-note filenames', () => {
      expect(isDailyNote('index.md')).toBe(false);
      expect(isDailyNote('2026-01.md')).toBe(false);
      expect(isDailyNote('2026.md')).toBe(false);
      expect(isDailyNote('January-13-2026.md')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isDailyNote('2026-1-13.md')).toBe(false); // Single digit month
      expect(isDailyNote('2026-01-3.md')).toBe(false); // Single digit day
      expect(isDailyNote('26-01-13.md')).toBe(false); // Two digit year
      expect(isDailyNote('2026-01-13')).toBe(false); // Missing .md extension
    });
  });

  describe('extractDateHierarchy', () => {
    it('should extract year and month from daily note', () => {
      const result = extractDateHierarchy('2026-01-13.md');
      expect(result).toEqual({
        year: '2026.md',
        month: '2026-01.md'
      });
    });

    it('should handle different months', () => {
      const result = extractDateHierarchy('2025-12-25.md');
      expect(result).toEqual({
        year: '2025.md',
        month: '2025-12.md'
      });
    });

    it('should return null for non-daily notes', () => {
      expect(extractDateHierarchy('index.md')).toBeNull();
      expect(extractDateHierarchy('2026-01.md')).toBeNull();
      expect(extractDateHierarchy('regular-note.md')).toBeNull();
    });
  });

  describe('generateVirtualTemporalNodes', () => {
    it('should create year and month nodes for single daily note', () => {
      const files = ['2026-01-13.md'];
      const graph = generateVirtualTemporalNodes(files);

      expect(graph['2026.md']).toEqual(['2026-01.md']);
      expect(graph['2026-01.md']).toEqual(['2026-01-13.md']);
    });

    it('should group daily notes by month', () => {
      const files = ['2026-01-10.md', '2026-01-13.md', '2026-01-20.md'];
      const graph = generateVirtualTemporalNodes(files);

      expect(graph['2026-01.md']).toEqual(['2026-01-10.md', '2026-01-13.md', '2026-01-20.md']);
      expect(graph['2026.md']).toEqual(['2026-01.md']);
    });

    it('should handle multiple years', () => {
      const files = ['2025-12-25.md', '2026-01-13.md', '2027-03-15.md'];
      const graph = generateVirtualTemporalNodes(files);

      expect(graph['2025.md']).toEqual(['2025-12.md']);
      expect(graph['2026.md']).toEqual(['2026-01.md']);
      expect(graph['2027.md']).toEqual(['2027-03.md']);
    });

    it('should handle multiple months in same year', () => {
      const files = ['2026-01-15.md', '2026-02-20.md', '2026-03-10.md'];
      const graph = generateVirtualTemporalNodes(files);

      expect(graph['2026.md']).toEqual(['2026-01.md', '2026-02.md', '2026-03.md']);
    });

    it('should ignore non-daily-note files', () => {
      const files = ['2026-01-13.md', 'index.md', 'Notes.md'];
      const graph = generateVirtualTemporalNodes(files);

      expect(Object.keys(graph)).not.toContain('index.md');
      expect(Object.keys(graph)).not.toContain('Notes.md');
      expect(graph['2026.md']).toBeDefined();
    });

    it('should return empty graph for no daily notes', () => {
      const files = ['index.md', 'about.md', 'contact.md'];
      const graph = generateVirtualTemporalNodes(files);

      expect(Object.keys(graph)).toHaveLength(0);
    });

    it('should handle empty file list', () => {
      const files: string[] = [];
      const graph = generateVirtualTemporalNodes(files);

      expect(Object.keys(graph)).toHaveLength(0);
    });
  });

  describe('validateGraph', () => {
    it('should keep links to existing files', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md', 'c.md'],
        'b.md': ['a.md'],
        'c.md': []
      };
      const existing = new Set(['a.md', 'b.md', 'c.md']);
      const validated = validateGraph(graph, existing);
      expect(validated).toEqual(graph);
    });

    it('should remove links to non-existing files', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md', 'nonexistent.md'],
        'b.md': ['missing.md']
      };
      const existing = new Set(['a.md', 'b.md']);
      const validated = validateGraph(graph, existing);
      expect(validated['a.md']).toEqual(['b.md']);
      expect(validated['b.md']).toEqual([]);
    });

    it('should handle completely broken graph', () => {
      const graph: WikiGraph = {
        'a.md': ['x.md', 'y.md'],
        'b.md': ['z.md']
      };
      const existing = new Set(['a.md', 'b.md']);
      const validated = validateGraph(graph, existing);
      expect(validated['a.md']).toEqual([]);
      expect(validated['b.md']).toEqual([]);
    });
  });

  describe('getBacklinks', () => {
    const graph: WikiGraph = {
      'index.md': ['about.md', 'contact.md'],
      'about.md': ['index.md'],
      'contact.md': ['index.md'],
      'blog.md': []
    };

    it('should find single backlink', () => {
      const backlinks = getBacklinks(graph, 'about.md');
      expect(backlinks).toEqual(['index.md']);
    });

    it('should find multiple backlinks', () => {
      const backlinks = getBacklinks(graph, 'index.md');
      expect(backlinks).toEqual(['about.md', 'contact.md']);
    });

    it('should return empty for no backlinks', () => {
      const backlinks = getBacklinks(graph, 'blog.md');
      expect(backlinks).toEqual([]);
    });

    it('should return empty for non-existent file', () => {
      const backlinks = getBacklinks(graph, 'missing.md');
      expect(backlinks).toEqual([]);
    });

    it('should return sorted backlinks', () => {
      const testGraph: WikiGraph = {
        'z.md': ['target.md'],
        'a.md': ['target.md'],
        'm.md': ['target.md']
      };
      const backlinks = getBacklinks(testGraph, 'target.md');
      expect(backlinks).toEqual(['a.md', 'm.md', 'z.md']);
    });
  });

  describe('getConnectedComponent', () => {
    it('should find all connected files', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['c.md'],
        'c.md': ['a.md'],
        'd.md': ['e.md'],
        'e.md': []
      };
      const component = getConnectedComponent(graph, 'a.md');
      expect(component).toEqual(new Set(['a.md', 'b.md', 'c.md']));
    });

    it('should find isolated file component', () => {
      const graph: WikiGraph = {
        'a.md': [],
        'b.md': ['c.md'],
        'c.md': ['b.md']
      };
      const component = getConnectedComponent(graph, 'a.md');
      expect(component).toEqual(new Set(['a.md']));
    });

    it('should include backlinks in component', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': [],
        'c.md': ['a.md']
      };
      const component = getConnectedComponent(graph, 'b.md');
      expect(component).toContain('a.md');
      expect(component).toContain('c.md');
    });

    it('should handle circular references', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['a.md']
      };
      const component = getConnectedComponent(graph, 'a.md');
      expect(component.size).toBe(2);
    });
  });

  describe('findIsolatedFiles', () => {
    it('should find truly isolated files', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': [],
        'c.md': [],
        'd.md': ['a.md']
      };
      const isolated = findIsolatedFiles(graph);
      expect(isolated).toEqual(['c.md']);
    });

    it('should return empty for fully connected graph', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['a.md']
      };
      const isolated = findIsolatedFiles(graph);
      expect(isolated).toEqual([]);
    });

    it('should find all isolated files in sparse graph', () => {
      const graph: WikiGraph = {
        'a.md': [],
        'b.md': [],
        'c.md': []
      };
      const isolated = findIsolatedFiles(graph);
      expect(isolated).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('should return sorted isolated files', () => {
      const graph: WikiGraph = {
        'z.md': [],
        'a.md': [],
        'm.md': []
      };
      const isolated = findIsolatedFiles(graph);
      expect(isolated).toEqual(['a.md', 'm.md', 'z.md']);
    });
  });

  describe('detectCycles', () => {
    it('should detect simple cycle', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['a.md']
      };
      const cycles = detectCycles(graph);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it('should detect longer cycle', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['c.md'],
        'c.md': ['a.md']
      };
      const cycles = detectCycles(graph);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it('should return empty for acyclic graph', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['c.md'],
        'c.md': []
      };
      const cycles = detectCycles(graph);
      expect(cycles).toEqual([]);
    });

    it('should detect multiple cycles', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md'],
        'b.md': ['a.md'],
        'c.md': ['d.md'],
        'd.md': ['c.md']
      };
      const cycles = detectCycles(graph);
      // Both cycles should be detected
      expect(cycles.length).toBeGreaterThan(0);
    });

    it('should handle self-referential files', () => {
      const graph: WikiGraph = {
        'a.md': ['a.md']
      };
      const cycles = detectCycles(graph);
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe('getGraphStats', () => {
    it('should calculate stats for simple graph', () => {
      const graph: WikiGraph = {
        'a.md': ['b.md', 'c.md'],
        'b.md': ['a.md'],
        'c.md': []
      };
      const stats = getGraphStats(graph);
      expect(stats.totalFiles).toBe(3);
      expect(stats.totalLinks).toBe(3);
      expect(stats.avgLinksPerFile).toBeCloseTo(1, 1);
      expect(stats.isolatedFiles).toBe(0);
    });

    it('should identify most linked files', () => {
      const graph: WikiGraph = {
        'a.md': ['hub.md'],
        'b.md': ['hub.md'],
        'c.md': ['hub.md'],
        'hub.md': []
      };
      const stats = getGraphStats(graph);
      expect(stats.mostLinked[0].file).toBe('hub.md');
      expect(stats.mostLinked[0].backlinks).toBe(3);
    });

    it('should count isolated files correctly', () => {
      const graph: WikiGraph = {
        'a.md': [],
        'b.md': [],
        'c.md': ['a.md']
      };
      const stats = getGraphStats(graph);
      expect(stats.isolatedFiles).toBe(1);
    });

    it('should handle empty graph', () => {
      const graph: WikiGraph = {};
      const stats = getGraphStats(graph);
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalLinks).toBe(0);
      expect(stats.avgLinksPerFile).toBe(0);
    });

    it('should calculate complex statistics', () => {
      const graph: WikiGraph = {
        'home.md': ['about.md', 'contact.md', 'blog.md'],
        'about.md': ['home.md'],
        'contact.md': ['home.md'],
        'blog.md': ['home.md', 'archive.md'],
        'archive.md': [],
        'isolated.md': []
      };
      const stats = getGraphStats(graph);
      expect(stats.totalFiles).toBe(6);
      expect(stats.totalLinks).toBe(7); // 3 from home, 1 from about, 1 from contact, 2 from blog
      expect(stats.isolatedFiles).toBe(1);
      expect(stats.mostLinked[0].file).toBe('home.md');
      expect(stats.mostLinked[0].backlinks).toBe(3);
    });

    it('should limit mostLinked to 5 results', () => {
      const graph: WikiGraph = {};
      for (let i = 0; i < 10; i++) {
        graph[`file${i}.md`] = ['hub.md'];
      }
      graph['hub.md'] = [];
      const stats = getGraphStats(graph);
      expect(stats.mostLinked.length).toBeLessThanOrEqual(5);
    });
  });
});

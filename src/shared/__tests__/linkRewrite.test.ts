import { describe, it, expect } from 'vitest';
import { rewriteLinks } from '../linkRewrite';
import { extractWikilinks } from '../wikilinks';

const rename = [{ from: 'Projects/Plan.md', to: 'Archive/Plan 2026.md' }];

describe('rewriteLinks', () => {
  it('rewrites plain, aliased, heading, .md, ./, and embed links, keeping their decorations', () => {
    const doc = [
      'See [[Projects/Plan]].',
      'Aliased: [[Projects/Plan|the plan]].',
      'Heading: [[Projects/Plan#Goals]] and [[Projects/Plan#Goals|goals]].',
      'Extension: [[Projects/Plan.md]], relative: [[./Projects/Plan]].',
      'Spaced: [[ Projects/Plan ]].',
      'Embed: ![[Projects/Plan]].'
    ].join('\n');
    const result = rewriteLinks(doc, rename);
    expect(result.doc).toBe(
      [
        'See [[Archive/Plan 2026]].',
        'Aliased: [[Archive/Plan 2026|the plan]].',
        'Heading: [[Archive/Plan 2026#Goals]] and [[Archive/Plan 2026#Goals|goals]].',
        'Extension: [[Archive/Plan 2026.md]], relative: [[./Archive/Plan 2026]].',
        'Spaced: [[ Archive/Plan 2026 ]].',
        'Embed: ![[Archive/Plan 2026]].'
      ].join('\n')
    );
    expect(result.linksChanged).toBe(8);
  });

  it('leaves other links alone, including look-alikes and different case', () => {
    const doc = '[[Projects/Plans]] [[Projects/Plan B]] [[projects/plan]] [[Plan]] [[Projects]]';
    expect(rewriteLinks(doc, rename)).toEqual({ doc, linksChanged: 0 });
  });

  it('matches exactly what the app treats as a link to the note', () => {
    const doc = 'a [[Projects/Plan#x|y]] b [[./Projects/Plan.md]] c [[Projects/Planner]]';
    const before = extractWikilinks(doc).filter((l) => l === 'Projects/Plan.md').length;
    expect(rewriteLinks(doc, rename).linksChanged).toBe(before);
  });

  it('with prefix, also rewrites links to child notes (moving a note with its subtree)', () => {
    const doc = '[[People]] [[People/John]] [[People/John/Notes#x]] [[PeopleExtra/X]]';
    const result = rewriteLinks(doc, [{ from: 'People.md', to: 'Contacts.md', prefix: true }]);
    expect(result.doc).toBe(
      '[[Contacts]] [[Contacts/John]] [[Contacts/John/Notes#x]] [[PeopleExtra/X]]'
    );
    expect(result.linksChanged).toBe(3);
  });

  it('applies several renames, first match wins, and ignores empty links', () => {
    const doc = '[[A]] [[B]] [[]] [[ ]]';
    const result = rewriteLinks(doc, [
      { from: 'A', to: 'A2' },
      { from: 'B.md', to: 'B2.md' }
    ]);
    expect(result.doc).toBe('[[A2]] [[B2]] [[]] [[ ]]');
  });
});

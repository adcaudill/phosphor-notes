import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { wikiLinkCompletionSource } from '../wikiLinkAutocomplete';

const pages = ['Fred Smith.md', 'Alice Jones.md', 'Project Plan.md'];

function runSource(doc: string, selection: EditorSelection) {
  const state = EditorState.create({ doc, selection });
  // CodeMirror builds the context at the start of the main selection
  const context = new CompletionContext(state, state.selection.main.from, false);
  return wikiLinkCompletionSource(pages)(context);
}

describe('Wiki Link Autocomplete', () => {
  it('lists all pages for an empty wiki link', () => {
    const doc = 'Call [[]]';
    const result = runSource(doc, EditorSelection.single(7));

    expect(result?.options.map((o) => o.label)).toEqual([
      'Alice Jones',
      'Fred Smith',
      'Project Plan'
    ]);
    expect(result?.from).toBe(7);
    expect(result?.to).toBe(7);
  });

  it('filters on text typed after [[', () => {
    const doc = 'Call [[fre';
    const result = runSource(doc, EditorSelection.single(doc.length));

    expect(result?.options.map((o) => o.label)).toEqual(['Fred Smith']);
  });

  it('filters on selected text wrapped in [[ ]]', () => {
    // Result of selecting "Fred" and typing [[ with closeBrackets
    const doc = 'Call [[Fred]]';
    const result = runSource(doc, EditorSelection.single(7, 11));

    expect(result?.options.map((o) => o.label)).toEqual(['Fred Smith']);
    expect(result?.from).toBe(7);
    expect(result?.to).toBe(11);
  });

  it('filters on a backwards selection wrapped in [[ ]]', () => {
    const doc = 'Call [[Fred]]';
    const result = runSource(doc, EditorSelection.single(11, 7));

    expect(result?.options.map((o) => o.label)).toEqual(['Fred Smith']);
    expect(result?.to).toBe(11);
  });

  it('returns null when the selected text matches no page', () => {
    const doc = 'Call [[Bob]]';
    const result = runSource(doc, EditorSelection.single(7, 10));

    expect(result).toBeNull();
  });
});

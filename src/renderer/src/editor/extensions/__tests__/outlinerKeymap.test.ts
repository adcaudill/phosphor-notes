import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { outlinerTab } from '../outlinerKeymap';

const applyTab = (doc: string, from: number, to: number): string => {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(from, to)
  });
  let updatedDoc = doc;
  const view = {
    state,
    dispatch: (transaction: Parameters<EditorView['dispatch']>[0]) => {
      updatedDoc = state.update(transaction).state.doc.toString();
    }
  } as unknown as EditorView;

  expect(outlinerTab(view)).toBe(true);
  return updatedDoc;
};

describe('outliner indentation', () => {
  it('indents every line in a selected block', () => {
    const doc = '- First\n- Second\n- Third';

    expect(applyTab(doc, 0, doc.length)).toBe('    - First\n    - Second\n    - Third');
  });

  it('does not include a line when the selection ends at its start', () => {
    const doc = '- First\n- Second';

    expect(applyTab(doc, 0, 8)).toBe('    - First\n- Second');
  });
});

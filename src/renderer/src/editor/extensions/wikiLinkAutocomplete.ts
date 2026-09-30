import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection } from '@codemirror/state';

/**
 * Completion source for wiki links
 * Provides completions when user types [[pagename
 */
export function wikiLinkCompletionSource(
  pages: string[]
): (context: CompletionContext) => CompletionResult | null {
  const normalizedPages = Array.from(new Set(pages.map((page) => page.replace(/\.md$/, '')))).sort(
    (a, b) => a.localeCompare(b)
  );

  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^\]\n]*$/);
    if (!match) return null;

    let query = match.text.slice(2); // Drop the leading [[
    const from = match.from + 2;
    let to = context.pos;

    // When text is selected and wrapped with [[ (closeBrackets keeps the inner text
    // selected), CodeMirror positions the context at the selection start. Treat the
    // selected text as part of the query so suggestions filter on it.
    const selection = context.state.selection.main;
    if (!selection.empty && selection.from === context.pos) {
      const selectedText = context.state.sliceDoc(selection.from, selection.to);
      if (!/[\]\n]/.test(selectedText)) {
        query += selectedText;
        to = selection.to;
      }
    }

    const lowered = query.toLowerCase();

    const options: Completion[] = normalizedPages
      .filter((name) => name.toLowerCase().includes(lowered))
      .map((name) => ({
        label: name,
        type: 'wiki',
        apply: (view, _completion, applyFrom, applyTo) => {
          const hasClosing = view.state.sliceDoc(applyTo, applyTo + 2) === ']]';
          const insertText = name + (hasClosing ? '' : ']]');
          const cursorAfter = applyFrom + name.length + 2; // position after the closing ']]'
          view.dispatch({
            changes: {
              from: applyFrom,
              to: applyTo,
              insert: insertText
            },
            selection: EditorSelection.single(cursorAfter)
          });
        }
      }));

    if (!options.length) return null;

    return {
      from,
      to,
      options,
      filter: false
    };
  };
}

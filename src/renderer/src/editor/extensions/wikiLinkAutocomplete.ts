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

    const query = match.text.slice(2); // Drop the leading [[
    const from = match.from + 2;
    const to = context.pos;
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

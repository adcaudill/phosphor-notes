import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

// Build an autocomplete source for wiki links based on known pages
export function createWikiLinkAutocomplete(pages: string[]): Extension {
  const normalizedPages = Array.from(new Set(pages.map((page) => page.replace(/\.md$/, '')))).sort(
    (a, b) => a.localeCompare(b)
  );

  const completionSource = (context: CompletionContext): CompletionResult | null => {
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
          view.dispatch({
            changes: {
              from: applyFrom,
              to: applyTo,
              insert: insertText
            }
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

  return autocompletion({
    override: [completionSource],
    activateOnTyping: true
  });
}

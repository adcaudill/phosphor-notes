import {
  autocompletion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { slashCommandsCompletionSource } from './slashCommands';
import { wikiLinkCompletionSource } from './wikiLinkAutocomplete';

/**
 * Combined autocomplete extension that merges wiki link and slash command completions
 * into a single extension to avoid CodeMirror config merge conflicts.
 *
 * This orchestrates multiple completion sources while keeping each source
 * isolated in its own module for maintainability.
 */
export function createCombinedAutocompleteExtension(pages: string[]): Extension {
  const wikiCompletionSource = wikiLinkCompletionSource(pages);
  const slashCompletionSource = slashCommandsCompletionSource;

  const combinedCompletionSource = (context: CompletionContext): CompletionResult | null => {
    // Try wiki links first ([[...]])
    const wikiResult = wikiCompletionSource(context);
    if (wikiResult) return wikiResult;

    // Fall back to slash commands (/....)
    const slashResult = slashCompletionSource(context);
    if (slashResult) return slashResult;

    return null;
  };

  return autocompletion({
    override: [combinedCompletionSource],
    activateOnTyping: true
  });
}

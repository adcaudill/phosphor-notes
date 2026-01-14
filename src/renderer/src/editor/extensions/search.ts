import { Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet } from '@codemirror/view';

interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  index: number;
  total: number;
}

const searchStateField = StateField.define<SearchState>({
  create: () => ({
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    index: 0,
    total: 0
  }),
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setSearchQuery)) {
        return e.value;
      }
    }
    return value;
  }
});

const setSearchQuery = StateEffect.define<SearchState>();

export interface SearchAPI {
  setQuery: (query: string, caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean) => void;
  getState: () => SearchState;
  nextMatch: () => void;
  prevMatch: () => void;
  replaceSelection: (replacement: string) => void;
  replaceAll: (replacement: string) => void;
  close: () => void;
}

const searchPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    searchState: SearchState;
    matches: Array<{ from: number; to: number }> = [];

    constructor(private view: EditorView) {
      this.searchState = view.state.field(searchStateField);
      this.decorations = Decoration.none;
      this.updateMatches();
    }

    updateMatches(): void {
      this.matches = [];
      const { query, caseSensitive, wholeWord, regex } = this.searchState;

      if (!query) {
        this.decorations = Decoration.none;
        return;
      }

      try {
        let pattern: string | RegExp;

        if (regex) {
          const flags = caseSensitive ? 'g' : 'gi';
          pattern = new RegExp(query, flags);
        } else {
          let escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (wholeWord) {
            escapedQuery = `\\b${escapedQuery}\\b`;
          }
          const flags = caseSensitive ? 'g' : 'gi';
          pattern = new RegExp(escapedQuery, flags);
        }

        const text = this.view.state.doc.toString();
        let match;

        // For regex pattern matching
        if (pattern instanceof RegExp) {
          while ((match = pattern.exec(text)) !== null) {
            this.matches.push({
              from: match.index,
              to: match.index + match[0].length
            });
          }
        }
      } catch {
        // Invalid regex, silently fail
      }

      // Create decorations for matches
      const ranges: Array<{ from: number; to: number; value: Decoration }> = [];
      for (let i = 0; i < this.matches.length; i++) {
        const { from, to } = this.matches[i];
        const isActive = i === this.searchState.index;
        ranges.push({
          from,
          to,
          value: Decoration.mark({
            class: isActive ? 'cm-search-match-active' : 'cm-search-match'
          })
        });
      }

      this.decorations = Decoration.set(ranges);
    }

    update(update: ViewUpdate): void {
      const oldState = this.searchState;
      this.searchState = update.state.field(searchStateField);

      if (
        oldState.query !== this.searchState.query ||
        oldState.caseSensitive !== this.searchState.caseSensitive ||
        oldState.wholeWord !== this.searchState.wholeWord ||
        oldState.regex !== this.searchState.regex ||
        update.docChanged
      ) {
        this.updateMatches();

        // Reset index if matches changed significantly
        if (this.matches.length > 0 && this.searchState.index >= this.matches.length) {
          this.searchState = {
            ...this.searchState,
            index: 0,
            total: this.matches.length
          };
        }
      } else {
        // Update total count
        this.searchState = {
          ...this.searchState,
          total: this.matches.length
        };
      }
    }

    destroy(): void {
      // Cleanup if needed
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

export const createSearchExtension = (): Extension => {
  return [searchStateField, searchPlugin];
};

export const createSearchAPI = (view: EditorView): SearchAPI => {
  return {
    setQuery: (query, caseSensitive = false, wholeWord = false, regex = false) => {
      view.dispatch({
        effects: setSearchQuery.of({
          query,
          caseSensitive,
          wholeWord,
          regex,
          index: 0,
          total: 0
        })
      });
    },

    getState: () => {
      return view.state.field(searchStateField);
    },

    nextMatch: () => {
      const plugin = view.plugin(searchPlugin);
      if (!plugin || plugin.matches.length === 0) return;

      const state = view.state.field(searchStateField);
      const nextIndex = (state.index + 1) % plugin.matches.length;
      const match = plugin.matches[nextIndex];

      view.dispatch({
        effects: setSearchQuery.of({
          ...state,
          index: nextIndex,
          total: plugin.matches.length
        }),
        selection: { anchor: match.from, head: match.to }
      });

      // Scroll into view
      view.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });
    },

    prevMatch: () => {
      const plugin = view.plugin(searchPlugin);
      if (!plugin || plugin.matches.length === 0) return;

      const state = view.state.field(searchStateField);
      const prevIndex = state.index === 0 ? plugin.matches.length - 1 : state.index - 1;
      const match = plugin.matches[prevIndex];

      view.dispatch({
        effects: setSearchQuery.of({
          ...state,
          index: prevIndex,
          total: plugin.matches.length
        }),
        selection: { anchor: match.from, head: match.to }
      });

      // Scroll into view
      view.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });
    },

    replaceSelection: (replacement) => {
      const state = view.state.field(searchStateField);
      const plugin = view.plugin(searchPlugin);
      if (!plugin || plugin.matches.length === 0 || state.index >= plugin.matches.length) return;

      const match = plugin.matches[state.index];
      view.dispatch({
        changes: {
          from: match.from,
          to: match.to,
          insert: replacement
        }
      });
    },

    replaceAll: (replacement) => {
      const plugin = view.plugin(searchPlugin);
      if (!plugin || plugin.matches.length === 0) return;

      // Sort matches in reverse order to maintain correct positions when replacing
      const sortedMatches = [...plugin.matches].reverse();
      const changes = sortedMatches.map((match) => ({
        from: match.from,
        to: match.to,
        insert: replacement
      }));

      view.dispatch({ changes });
    },

    close: () => {
      view.dispatch({
        effects: setSearchQuery.of({
          query: '',
          caseSensitive: false,
          wholeWord: false,
          regex: false,
          index: 0,
          total: 0
        })
      });
    }
  };
};

import {
  Decoration,
  EditorView,
  KeyBinding,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap
} from '@codemirror/view';
import { completionStatus } from '@codemirror/autocomplete';
import { EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import type { PredictionEngine } from '../../utils/predictionEngine';

interface Suggestion {
  text: string;
  pos: number;
  kind: 'completion' | 'next';
}

interface SoftSpace {
  pos: number;
  punctuationPending: boolean;
}

const setSuggestion = StateEffect.define<Suggestion | null>();
const setSoftSpace = StateEffect.define<SoftSpace | null>();

const attachingPunctuation = /^[,!?;:)\]}%]$/;

export function shouldAttachPunctuation(text: string): boolean {
  return attachingPunctuation.test(text);
}

export function shouldPreservePeriodSpace(text: string): boolean {
  return /^\.?[A-Z]/.test(text);
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestion)) return effect.value;
    }
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (val) => {
      if (!val) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostSuggestionWidget(val.text),
          side: 1
        }).range(val.pos)
      ]);
    })
});

const softSpaceField = StateField.define<SoftSpace | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSoftSpace)) return effect.value;
    }
    if (tr.docChanged || tr.selection) return null;
    return value;
  }
});

class GhostSuggestionWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ghost-suggestion';
    span.textContent = this.text;
    return span;
  }
}

function handleSoftSpaceInput(view: EditorView, from: number, to: number, text: string): boolean {
  const softSpace = view.state.field(softSpaceField, false);
  if (!softSpace || from !== to || from !== softSpace.pos + 1) return false;
  if (view.state.doc.sliceString(softSpace.pos, from) !== ' ') return false;

  if (!softSpace.punctuationPending && text === '.') {
    view.dispatch({
      changes: { from, to, insert: text },
      effects: setSoftSpace.of({ ...softSpace, punctuationPending: true }),
      selection: EditorSelection.cursor(from + text.length)
    });
    return true;
  }

  if (!softSpace.punctuationPending && shouldAttachPunctuation(text)) {
    view.dispatch({
      changes: { from: softSpace.pos, to, insert: text },
      effects: setSoftSpace.of(null),
      selection: EditorSelection.cursor(softSpace.pos + text.length)
    });
    return true;
  }

  if (!softSpace.punctuationPending) return false;

  if (shouldPreservePeriodSpace(text)) return false;

  view.dispatch({
    changes: { from: softSpace.pos, to, insert: `.${text}` },
    effects: setSoftSpace.of(null),
    selection: EditorSelection.cursor(softSpace.pos + text.length + 1)
  });
  return true;
}

function getSentenceContext(view: EditorView, head: number): string {
  const windowStart = Math.max(0, head - 500);
  const text = view.state.doc.sliceString(windowStart, head);
  // Look for the last sentence-ish boundary; fall back to window start.
  const match = Array.from(text.matchAll(/([.!?]["')\]]?\s|\n{2,})/g)).pop();
  const boundaryIdx = match ? match.index! + match[0].length : 0;
  return text.slice(boundaryIdx).trim();
}

function computeSuggestion(
  view: EditorView,
  getEngine: () => PredictionEngine | null
): Suggestion | null {
  // If CodeMirror's autocompletion is active (wiki links, slash commands),
  // prefer that and don't show quick-type suggestions.
  if (completionStatus(view.state) === 'active') return null;

  // Also check for the autocomplete tooltip element in the DOM. In some
  // configurations the status may not reflect the visible tooltip immediately,
  // so prefer a DOM check to ensure autocomplete takes visual priority.
  if (view.dom && view.dom.querySelector && view.dom.querySelector('.cm-tooltip-autocomplete'))
    return null;

  const sel = view.state.selection.main;
  if (!sel.empty) return null;

  const engine = getEngine();
  if (!engine) return null;

  const head = sel.head;
  const line = view.state.doc.lineAt(head);
  const before = view.state.doc.sliceString(line.from, head);
  const after = view.state.doc.sliceString(head, head + 1);
  const context = getSentenceContext(view, head);
  const isSentenceStart = context.length === 0;

  // If there's any non-whitespace text immediately after the cursor,
  // avoid offering an in-word completion to prevent corrupting existing text.
  if (after && /\S/.test(after)) return null;

  // Next-word prediction when the last typed char is whitespace
  if (/\s$/.test(before)) {
    const trimmed = before.trim();
    const parts = trimmed.split(/\s+/);
    const prevWord = parts[parts.length - 1] || '';
    const prevPrevWord = parts[parts.length - 2] || '';
    if (prevWord) {
      const next = engine.predictNext(prevWord, prevPrevWord || null, context, {
        isSentenceStart
      });
      if (next) {
        return { text: `${next} `, pos: head, kind: 'next' };
      }
    }
  }

  // In-word completion
  const match = before.match(/([A-Za-z0-9']+)$/);
  if (!match) return null;
  const prefix = match[1];
  if (!prefix) return null;

  const completion = engine.predictCompletion(prefix, context);
  if (!completion) return null;
  const suffix = completion.slice(prefix.length);
  if (!suffix) return null;

  return { text: suffix, pos: head, kind: 'completion' };
}

function acceptSuggestion(view: EditorView): boolean {
  const suggestion = view.state.field(suggestionField, false);
  if (!suggestion) return false;

  const insertAt = view.state.selection.main.head;
  const insertedSpace = suggestion.text.endsWith(' ');
  const tr = view.state.update({
    changes: { from: insertAt, to: insertAt, insert: suggestion.text },
    effects: [
      setSuggestion.of(null),
      ...(insertedSpace
        ? [
            setSoftSpace.of({
              pos: insertAt + suggestion.text.length - 1,
              punctuationPending: false
            })
          ]
        : [])
    ],
    selection: EditorSelection.cursor(insertAt + suggestion.text.length)
  });
  view.dispatch(tr);
  return true;
}

function createKeymap(): KeyBinding[] {
  return [
    {
      key: 'Tab',
      run: acceptSuggestion,
      preventDefault: true
    }
  ];
}

export function createQuickTypeExtension(getEngine: () => PredictionEngine | null): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private pending = false;

      constructor(private readonly view: EditorView) {
        this.scheduleRefresh();
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet) return;
        this.scheduleRefresh();
      }

      private scheduleRefresh(): void {
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
          this.pending = false;
          const next = computeSuggestion(this.view, getEngine);
          const current = this.view.state.field(suggestionField, false);
          const same =
            (!current && !next) ||
            (current && next && current.text === next.text && current.pos === next.pos);
          if (same) return;
          this.view.dispatch({ effects: setSuggestion.of(next) });
        });
      }
    }
  );

  const theme = EditorView.theme({
    '.cm-ghost-suggestion': {
      color: 'var(--editor-muted)',
      opacity: 0.8,
      pointerEvents: 'none'
    }
  });

  return [
    suggestionField,
    softSpaceField,
    plugin,
    theme,
    Prec.highest(EditorView.inputHandler.of(handleSoftSpaceInput)),
    Prec.highest(keymap.of(createKeymap()))
  ];
}

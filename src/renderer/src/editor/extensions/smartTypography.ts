import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';

interface Replacement {
  from: number;
  to: number;
  insert: string;
  cursor?: number;
}

function isInsideCode(state: EditorState, pos: number): boolean {
  // Skip transformations inside inline or fenced code blocks by counting unmatched backticks
  const before = state.sliceDoc(0, pos);
  const fenceCount = (before.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) return true;
  const inlineCount = (before.match(/`/g) ?? []).length;
  return inlineCount % 2 === 1;
}

function getHyphenRun(state: EditorState, pos: number): number {
  let count = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (state.sliceDoc(i, i + 1) === '-') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function maybeHandleDashes(
  state: EditorState,
  from: number,
  to: number,
  text: string
): Replacement | null {
  if (text === '-' && from > 0 && state.sliceDoc(from - 1, from) === '–') {
    return { from: from - 1, to, insert: '—' };
  }

  if (!/^-+$/.test(text)) return null;

  const runBefore = getHyphenRun(state, from);
  const total = runBefore + text.length;
  if (total !== 2 && total !== 3) return null;

  const line = state.doc.lineAt(from);
  const insertion = '-'.repeat(text.length);
  const lineAfter = state.sliceDoc(line.from, from) + insertion + state.sliceDoc(to, line.to);
  const trimmed = lineAfter.trim();
  if (trimmed === '--' || trimmed === '---') {
    // Preserve Markdown horizontal rules/frontmatter fences
    return null;
  }

  const replacement = total === 3 ? '—' : '–';
  return { from: from - runBefore, to, insert: replacement };
}

function maybeHandleEllipsis(
  state: EditorState,
  from: number,
  to: number,
  text: string
): Replacement | null {
  if (text !== '.') return null;
  const prevTwo = state.sliceDoc(Math.max(0, from - 2), from);
  if (prevTwo !== '..') return null;
  return { from: from - 2, to, insert: '…' };
}

function maybeHandleSymbols(
  state: EditorState,
  from: number,
  to: number,
  text: string
): Replacement | null {
  if (text.length !== 1) return null;

  const patternMap: Array<{ key: string; symbol: string }> = [
    { key: '(c)', symbol: '©' },
    { key: '(r)', symbol: '®' },
    { key: '(tm)', symbol: '™' }
  ];

  for (const { key, symbol } of patternMap) {
    const patternLen = key.length;

    // Typed char completes the pattern (e.g., typing ')')
    const startWithChar = from - (patternLen - 1);
    if (startWithChar >= 0) {
      const tailWithChar = (state.sliceDoc(startWithChar, from) + text).toLowerCase();
      if (tailWithChar === key) {
        const suffix = text === ')' ? '' : text;
        return { from: startWithChar, to, insert: `${symbol}${suffix}` };
      }
    }
  }

  return null;
}

function maybeHandleQuotes(
  state: EditorState,
  from: number,
  to: number,
  text: string
): Replacement | null {
  if (text !== '"' && text !== "'") return null;

  const prevChar = state.sliceDoc(Math.max(0, from - 1), from);
  const nextChar = state.sliceDoc(to, to + 1);
  const looksLikeYearApostrophe =
    text === "'" && (!prevChar || /\s/.test(prevChar)) && /\d/.test(nextChar ?? '');
  const isOpening = (!prevChar || /[\s([{>]/.test(prevChar)) && !looksLikeYearApostrophe;

  const replacement = text === '"' ? (isOpening ? '“' : '”') : isOpening ? '‘' : '’';
  return { from, to, insert: replacement };
}

function findSymbolBeforeCursor(state: EditorState, pos: number): Replacement | null {
  const tail = state.sliceDoc(Math.max(0, pos - 5), pos).toLowerCase();
  const patternMap: Array<{ key: string; symbol: string }> = [
    { key: '(c)', symbol: '©' },
    { key: '(r)', symbol: '®' },
    { key: '(tm)', symbol: '™' }
  ];

  for (const { key, symbol } of patternMap) {
    if (!tail.endsWith(key)) continue;
    const start = pos - key.length;
    if (start < 0) return null;
    return { from: start, to: pos, insert: symbol };
  }

  return null;
}

export function smartTypographyExtension(): Extension {
  const inputHandler = EditorView.inputHandler.of((view, from, to, text) => {
    if (!text || isInsideCode(view.state, from)) {
      return false;
    }

    const handlers = [
      maybeHandleDashes(view.state, from, to, text),
      maybeHandleEllipsis(view.state, from, to, text),
      maybeHandleSymbols(view.state, from, to, text),
      maybeHandleQuotes(view.state, from, to, text)
    ];

    const replacement = handlers.find(Boolean) as Replacement | undefined;
    if (!replacement) return false;

    const selectionAnchor =
      typeof replacement.cursor === 'number'
        ? replacement.cursor
        : replacement.from + replacement.insert.length;

    view.dispatch({
      changes: { from: replacement.from, to: replacement.to, insert: replacement.insert },
      selection: { anchor: selectionAnchor }
    });
    return true;
  });

  const symbolOnMove = ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate): void {
        if (!update.selectionSet && !update.docChanged) return;
        const pos = update.state.selection.main.head;
        if (isInsideCode(update.state, pos)) return;
        const replacement = findSymbolBeforeCursor(update.state, pos);
        if (!replacement) return;

        update.view.dispatch({
          changes: { from: replacement.from, to: replacement.to, insert: replacement.insert },
          selection: { anchor: replacement.from + replacement.insert.length }
        });
      }
    }
  );

  return [inputHandler, symbolOnMove];
}

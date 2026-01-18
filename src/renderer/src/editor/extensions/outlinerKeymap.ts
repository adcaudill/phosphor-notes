import {
  Decoration,
  DecorationSet,
  EditorView,
  KeyBinding,
  ViewPlugin,
  ViewUpdate,
  keymap
} from '@codemirror/view';
import { ChangeSpec, EditorSelection, Prec, RangeSetBuilder, type Extension } from '@codemirror/state';

/**
 * Get the indentation level of a line (number of spaces at the start)
 */
function getIndentationLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Get the indentation string (just the leading spaces)
 */
function getIndentationString(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

/**
 * Find the indentation of the nearest bullet line above (including current).
 * Fallback to the current line indentation if no bullet is found.
 */
function findBulletIndent(state: EditorView['state'], lineNumber: number): string {
  for (let n = lineNumber; n >= 1; n--) {
    const line = state.doc.line(n);
    const bulletMatch = line.text.match(/^(\s*)-\s/);
    if (bulletMatch) return bulletMatch[1];
  }
  const current = state.doc.line(lineNumber).text;
  const indent = getIndentationString(current);

  // If we're on a continuation/blank line (indent + two spaces), strip the continuation pad
  if (indent.length >= 2 && current.trim() === '') {
    return indent.slice(0, -2);
  }

  // If the line is a continuation with text (indent + two spaces, then text not starting with dash)
  const contMatch = current.match(/^(\s{2,})(?!-\s)/);
  if (contMatch && contMatch[1].length >= 2) {
    return contMatch[1].slice(0, -2);
  }

  return indent;
}

/**
 * Handler for Enter key in outliner mode
 * Creates a new bullet point at the same indentation level
 */
export const outlinerEnter = (view: EditorView): boolean => {
  const transaction = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head);
    // Use the nearest bullet's indent so continuations (Shift+Enter) don't drift deeper
    const bulletIndent = findBulletIndent(view.state, line.number);
    const insertText = '\n' + bulletIndent + '- ';

    const change: ChangeSpec = { from: range.head, to: range.head, insert: insertText };
    const cursor = EditorSelection.cursor(range.head + insertText.length);
    return { changes: change, range: cursor };
  });

  view.dispatch(transaction);
  return true;
};

/**
 * Shift+Enter: insert a soft break inside the current bullet (continuation line)
 * Keeps user inside the same list item instead of creating a new bullet.
 */
export const outlinerSoftBreak = (view: EditorView): boolean => {
  const transaction = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head);
    const bulletIndent = findBulletIndent(view.state, line.number);

    // Continuation lines align under the text of the current bullet (indent + two spaces)
    const continuation = '\n' + bulletIndent + '  ';
    const change: ChangeSpec = { from: range.head, to: range.head, insert: continuation };
    const cursor = EditorSelection.cursor(range.head + continuation.length);
    return { changes: change, range: cursor };
  });

  view.dispatch(transaction);
  return true;
};

/**
 * Handler for Tab key in outliner mode
 * Indents the current line and its children
 */
export const outlinerTab = (view: EditorView): boolean => {
  const changes: ChangeSpec[] = [];

  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head);

    // Add 4 spaces (one tab stop)
    changes.push({
      from: line.from,
      to: line.from,
      insert: '    '
    });
  }

  if (changes.length > 0) {
    view.dispatch({ changes });
    return true;
  }
  return false;
};

/**
 * Handler for Shift+Tab in outliner mode
 * Outdents the current line and its children
 */
export const outlinerShiftTab = (view: EditorView): boolean => {
  const changes: ChangeSpec[] = [];

  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head);
    const indent = getIndentationLevel(line.text);

    // Only outdent if there's indentation to remove
    if (indent > 0) {
      // Remove up to 4 spaces (one tab stop)
      const removeCount = Math.min(4, indent);
      changes.push({
        from: line.from,
        to: line.from + removeCount
      });
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes });
    return true;
  }
  return false;
};

/**
 * Create the outliner keymap for CodeMirror
 * This overrides default Enter and Tab behavior in outliner mode
 */
export function createOutlinerKeymap(): KeyBinding[] {
  return [
    {
      key: 'Enter',
      run: outlinerEnter,
      shift: outlinerSoftBreak
    },
    {
      key: 'Tab',
      run: outlinerTab
    },
    {
      key: 'Shift-Tab',
      run: outlinerShiftTab
    }
  ];
}

// High-precedence keymap extension to override markdown list continuation
export const outlinerKeymapExtension: Extension = Prec.high(keymap.of(createOutlinerKeymap()));

// Apply hanging indents so wrapped lines stay aligned under their list item text
export const outlinerHangingIndentExtension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();

      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const indent = this.hangingIndentColumns(line.text);

          if (indent > 0) {
            const indentValue = `${indent}ch`;
            builder.add(
              line.from,
              line.from,
              Decoration.line({
                attributes: {
                  style: `text-indent:-${indentValue};padding-left:${indentValue};`
                }
              })
            );
          }

          pos = line.to + 1;
        }
      }

      return builder.finish();
    }

    hangingIndentColumns(text: string): number {
      // Bullet lines indent by their leading spaces plus the marker width
      const bulletMatch = text.match(/^(\s*)-\s/);
      if (bulletMatch) return bulletMatch[1].length + 2;

      // Continuation lines rely on their leading spaces
      const leadingSpaces = text.match(/^(\s+)/);
      if (leadingSpaces) return leadingSpaces[1].length;

      return 0;
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

import {
  Decoration,
  DecorationSet,
  EditorView,
  KeyBinding,
  ViewPlugin,
  ViewUpdate,
  keymap
} from '@codemirror/view';
import {
  ChangeSpec,
  EditorSelection,
  Prec,
  RangeSetBuilder,
  type Extension
} from '@codemirror/state';
import { editorColumns } from './editorColumns';

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

function getSelectedLineNumbers(state: EditorView['state']): number[] {
  const lineNumbers = new Set<number>();

  for (const range of state.selection.ranges) {
    let end = range.to;

    // A selection ending at the start of a line should not include that line.
    if (end > range.from && end < state.doc.length && state.doc.lineAt(end).from === end) {
      end -= 1;
    }

    const firstLine = state.doc.lineAt(range.from).number;
    const lastLine = state.doc.lineAt(end).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      lineNumbers.add(lineNumber);
    }
  }

  return Array.from(lineNumbers).sort((first, second) => first - second);
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
 * Find the nearest bullet line (including current) above the given line number.
 * Returns the line and the regex match if found, otherwise null.
 */
function findNearestBulletLine(
  state: EditorView['state'],
  lineNumber: number
): {
  line: { from: number; to: number; number: number; text: string };
  match: RegExpMatchArray;
} | null {
  for (let n = lineNumber; n >= 1; n--) {
    const line = state.doc.line(n);
    const match = line.text.match(/^(\s*)-\s*(\[(?: |x|X)\]\s)?/);
    if (match) return { line, match };
  }
  return null;
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

    // If the nearest bullet above (or current) is a task (has a checkbox),
    // insert a new unchecked checkbox `- [ ] ` for the new item.
    const nearest = findNearestBulletLine(view.state, line.number);
    let insertText = '\n' + bulletIndent + '- ';
    if (nearest && /\[(?: |x|X)\]/.test(nearest.line.text)) {
      insertText = '\n' + bulletIndent + '- [ ] ';
    }

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

  for (const lineNumber of getSelectedLineNumbers(view.state)) {
    const line = view.state.doc.line(lineNumber);
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

  for (const lineNumber of getSelectedLineNumbers(view.state)) {
    const line = view.state.doc.line(lineNumber);
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
 * Handler for Backspace/Delete in outliner mode
 * 1. If the cursor is inside a checkbox area (like `- [ ] `), remove the checkbox
 *    but keep the bullet marker (`- `).
 * 2. If the cursor is at or just after the bullet marker (`-`), delete the entire
 *    line and place the cursor at the end of the previous line.
 */
export const outlinerDelete = (view: EditorView): boolean => {
  // First pass: detect if any cursor needs special handling
  let shouldHandle = false;
  let handleType: 'checkbox' | 'bullet' = 'checkbox';

  for (const range of view.state.selection.ranges) {
    if (!range.empty) continue;
    const line = view.state.doc.lineAt(range.head);

    // Check if cursor is inside a checkbox area
    const checkboxMatch = line.text.match(/^(\s*)-\s*(\[(?: |x|X)\]\s)/);
    if (checkboxMatch) {
      const indentLen = checkboxMatch[1].length;
      const checkboxStart = line.from + indentLen + 2; // after '- '
      const checkboxEnd = checkboxStart + checkboxMatch[2].length;
      if (range.head >= checkboxStart && range.head <= checkboxEnd) {
        shouldHandle = true;
        handleType = 'checkbox';
        break;
      }
    }

    // Check if cursor is at or just after the bullet marker
    const bulletMatch = line.text.match(/^(\s*)-\s/);
    if (bulletMatch) {
      const indentLen = bulletMatch[1].length;
      const bulletStart = line.from + indentLen;
      const bulletEnd = line.from + indentLen + 2; // '- '

      // If cursor is at the dash or within the bullet marker area
      if (range.head >= bulletStart && range.head <= bulletEnd) {
        shouldHandle = true;
        handleType = 'bullet';
        break;
      }
    }
  }

  if (!shouldHandle) return false;

  // Build a change per-range using changeByRange so cursor positions are set correctly
  const transaction = view.state.changeByRange((range) => {
    if (!range.empty) return { changes: [], range };
    const line = view.state.doc.lineAt(range.head);

    if (handleType === 'checkbox') {
      const checkboxMatch = line.text.match(/^(\s*)-\s*(\[(?: |x|X)\]\s)/);
      if (checkboxMatch) {
        const indentLen = checkboxMatch[1].length;
        const checkboxStart = line.from + indentLen + 2;
        const checkboxEnd = checkboxStart + checkboxMatch[2].length;
        if (range.head >= checkboxStart && range.head <= checkboxEnd) {
          const change: ChangeSpec = { from: checkboxStart, to: checkboxEnd, insert: '' };
          const cursor = EditorSelection.cursor(checkboxStart);
          return { changes: change, range: cursor };
        }
      }
    } else if (handleType === 'bullet') {
      const bulletMatch = line.text.match(/^(\s*)-\s/);
      if (bulletMatch) {
        const indentLen = bulletMatch[1].length;
        const bulletStart = line.from + indentLen;
        const bulletEnd = line.from + indentLen + 2;

        if (range.head >= bulletStart && range.head <= bulletEnd) {
          // If this is the first line, just clear it
          if (line.number === 1) {
            const change: ChangeSpec = { from: line.from, to: line.to, insert: '' };
            const cursor = EditorSelection.cursor(line.from);
            return { changes: change, range: cursor };
          }

          // Delete the bullet marker and indentation, but preserve line content
          // by merging it with the previous line
          const prevLine = view.state.doc.line(line.number - 1);
          const contentStart = line.from + indentLen + 2; // Position after '- '
          const change: ChangeSpec = { from: prevLine.to, to: contentStart };
          const cursor = EditorSelection.cursor(prevLine.to);
          return { changes: change, range: cursor };
        }
      }
    }

    return { changes: [], range };
  });

  view.dispatch(transaction);
  return true;
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
      key: 'Backspace',
      run: outlinerDelete
    },
    {
      key: 'Delete',
      run: outlinerDelete
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
            const indentValue = editorColumns(indent);
            builder.add(
              line.from,
              line.from,
              Decoration.line({
                attributes: {
                  style: `text-indent:calc(-1 * ${indentValue});padding-left:${indentValue};`
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
      // Task lines hang under the task text, after "- [ ] ". The checkbox
      // widget takes exactly the width of the characters it replaces, so
      // the text stays in its source column whether or not the widget is
      // shown. (The widgets reset `text-indent` - it's inherited, and the
      // negative value here used to shift their contents left.)
      const task = text.match(/^\s*-\s*\[[ x/]\]\s*/);
      if (task) return task[0].length;

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

/**
 * Where to draw outliner nesting guides: for each line of `lines`, the
 * columns (in characters from the left edge) of every guide that passes
 * through it.
 *
 * Each bullet that has child bullets gets a guide under its dash, running
 * from the line after it to the last line of its subtree - child bullets
 * (task lines included), continuation lines, and blank lines in between - so
 * the line is unbroken from a parent down to its last descendant. A bullet
 * with no child bullets gets no guide.
 *
 * Guides used to be decided line by line and were only drawn on plain bullet
 * lines, so any task line, continuation line, or blank line inside a subtree
 * left a gap in it.
 */
export function computeNestingGuides(lines: string[]): number[][] {
  const guides: number[][] = lines.map(() => []);
  const stack: Array<{ indent: number; start: number; last: number; hasChild: boolean }> = [];

  const close = (open: {
    indent: number;
    start: number;
    last: number;
    hasChild: boolean;
  }): void => {
    if (!open.hasChild) return;
    for (let i = open.start + 1; i <= open.last; i++) guides[i].push(open.indent + 1);
  };

  lines.forEach((text, i) => {
    if (text.trim() === '') return; // blank lines take whatever guides span them
    const width = text.length - text.trimStart().length;
    const isBullet = /^\s*-(\s|$)/.test(text);

    // A line belongs to every open bullet indented less than it; close the rest.
    while (stack.length > 0 && stack[stack.length - 1].indent >= width) close(stack.pop()!);

    for (const open of stack) open.last = i;
    if (isBullet) {
      if (stack.length > 0) stack[stack.length - 1].hasChild = true;
      stack.push({ indent: width, start: i, last: i, hasChild: false });
    }
  });
  while (stack.length > 0) close(stack.pop()!);

  for (const columns of guides) columns.sort((a, b) => a - b);
  return guides;
}

/**
 * The line's background: a 1px-wide band at each guide column.
 *
 * Columns are measured with editorColumns(), which includes the editor's
 * letter-spacing, so a guide stays under its dash at any nesting depth.
 *
 * The band is a fixed 1px, not a fraction of `ch`. At 0.05ch (about 0.43px
 * with the editor's 14px Menlo) the band is narrower than a pixel, so it only
 * shows when it happens to cover a pixel's sample point - which depends on
 * where its column falls on the pixel grid (font size, display scale, the
 * editor's own offsets). Rendered offscreen at 1x, every other column drew
 * nothing at all, which is why some nesting levels had a guide and others
 * didn't. A 1px band always covers a sample point.
 */
export function guideBackground(columns: number[]): string {
  const stops: string[] = [];
  for (const col of columns) {
    const start = editorColumns(col);
    const end = `calc(${start} + 1px)`;
    stops.push(`transparent ${start}`);
    stops.push(`var(--editor-nesting-guide) ${start}`);
    stops.push(`var(--editor-nesting-guide) ${end}`);
    stops.push(`transparent ${end}`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// Visual guide lines for nested outliner structure. The guide is a background
// gradient on the line element, so it doesn't affect layout - which is why it
// can also be drawn on task lines (only the hanging indent, which changes
// text-indent/padding, has to skip them; see hangingIndentColumns).
export const outlinerNestingGuidesExtension: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private guides: number[][] = [];

    constructor(view: EditorView) {
      this.guides = this.computeGuides(view);
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.guides = this.computeGuides(update.view);
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }

    // A guide can start far above the viewport (a parent bullet off screen),
    // so the structure is worked out for the whole note, once per change.
    computeGuides(view: EditorView): number[][] {
      const lines: string[] = [];
      for (let n = 1; n <= view.state.doc.lines; n++) lines.push(view.state.doc.line(n).text);
      return computeNestingGuides(lines);
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = view.state.doc.lineAt(pos);
          const columns = this.guides[line.number - 1];
          if (columns && columns.length > 0) {
            builder.add(
              line.from,
              line.from,
              Decoration.line({
                class: 'cm-nesting-guide',
                attributes: { style: `background: ${guideBackground(columns)};` }
              })
            );
          }
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

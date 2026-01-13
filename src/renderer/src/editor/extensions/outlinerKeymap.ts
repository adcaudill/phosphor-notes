import { EditorView, KeyBinding } from '@codemirror/view';
import { ChangeSpec } from '@codemirror/state';

/**
 * Get the indentation level of a line (number of spaces at the start)
 */
function getIndentationLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Check if a line is a bullet point (starts with optional spaces, dash, and space)
 */
function isBulletLine(line: string): boolean {
  return /^\s*-\s/.test(line);
}

/**
 * Get the indentation string (just the leading spaces)
 */
function getIndentationString(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

/**
 * Handler for Enter key in outliner mode
 * Creates a new bullet point at the same indentation level
 */
export const outlinerEnter = (view: EditorView): boolean => {
  const changes: ChangeSpec[] = [];

  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head);
    const lineText = line.text;

    // Get the current indentation
    const indent = getIndentationString(lineText);

    // Check if this is a bullet line
    if (isBulletLine(lineText)) {
      // Check if the line is just a bullet (empty bullet point)
      const afterBullet = lineText.replace(/^(\s*-\s)/, '');
      if (afterBullet.trim() === '') {
        // Empty bullet: delete the bullet and outdent
        changes.push({
          from: line.from,
          to: line.to,
          insert: ''
        });
      } else {
        // Non-empty bullet: add new line with bullet at same indent
        changes.push({
          from: range.head,
          to: range.head,
          insert: '\n' + indent + '- '
        });
      }
    } else {
      // Not a bullet line: just add a new line with bullet
      changes.push({
        from: range.head,
        to: range.head,
        insert: '\n' + indent + '- '
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
      shift: (view) => {
        // Shift+Enter just inserts a newline without bullet
        const pos = view.state.selection.main.head;
        view.dispatch({
          changes: { from: pos, insert: '\n' }
        });
        return true;
      }
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

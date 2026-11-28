/**
 * A "Convert to task" marker in the gutter beside an inline checkbox task
 * (`- [ ] ...`) on the cursor's line. Clicking it opens the task capture
 * field in conversion mode for that line (the same as Mod-Shift-T there):
 * pre-filled with the line's text, with any old 📅/🔁/🔺 or @due metadata
 * as words.
 *
 * Inline task metadata isn't rendered as pills any more - task files are
 * where dates, repeats and priorities live - so this is the one-click way to
 * turn such a line into a real task.
 */
import { gutter, GutterMarker, type EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { TASK_LINE_RE } from '../../../../shared/tasks';
import { isConvertibleTaskLine } from '../../../../shared/taskMigrate';

class ConvertMarker extends GutterMarker {
  constructor(
    readonly lineNumber: number,
    readonly hasMetadata: boolean
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof ConvertMarker &&
      other.lineNumber === this.lineNumber &&
      other.hasMetadata === this.hasMetadata
    );
  }

  toDOM(): Node {
    const span = document.createElement('span');
    span.className = `cm-task-convert ${this.hasMetadata ? 'has-metadata' : ''}`;
    span.setAttribute('data-task-line', String(this.lineNumber));
    span.title = this.hasMetadata
      ? 'Convert to a task (keeps its date, repeat and priority) - ⌘⇧T'
      : 'Convert to a task - ⌘⇧T';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = 'add_task';
    span.appendChild(icon);
    return span;
  }
}

export const taskConvertGutter = gutter({
  class: 'cm-task-convert-gutter',
  lineMarker(view, line) {
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.from).number;
    const lineNumber = view.state.doc.lineAt(line.from).number;
    if (lineNumber !== cursorLine) return null;
    const text = view.state.doc.line(lineNumber).text;
    if (!TASK_LINE_RE.test(text)) return null;
    return new ConvertMarker(lineNumber, isConvertibleTaskLine(text));
  },
  lineMarkerChange: (update: ViewUpdate) => update.docChanged || update.selectionSet,
  domEventHandlers: {
    click: (view: EditorView, _line, event: Event) => {
      const target = (event as MouseEvent).target as HTMLElement | null;
      const el = target?.closest?.('.cm-task-convert') as HTMLElement | null;
      if (!el) return false;
      event.preventDefault();
      const lineNumber = Number(el.getAttribute('data-task-line'));
      if (!lineNumber || lineNumber > view.state.doc.lines) return false;
      // Put the cursor on that line, then ask the editor for the capture field (Editor.tsx).
      view.dispatch({ selection: { anchor: view.state.doc.line(lineNumber).to } });
      view.dom.dispatchEvent(new CustomEvent('phosphor-task-capture'));
      return true;
    }
  }
});

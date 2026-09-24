/**
 * A small "+" gutter marker, shown next to the line the cursor is
 * currently on when it's a bare task with no due date/recurrence/priority
 * yet - the discoverability affordance for adding metadata without
 * hand-typing emoji syntax.
 *
 * This used to be an inline widget positioned right before the checkbox
 * bracket, but that put it inside the same text flow the outliner's
 * hanging-indent trick manipulates (outlinerKeymap.ts sets a negative
 * `text-indent` + matching `padding-left` on bullet lines so wrapped
 * continuation lines hang under the bullet text), and the nesting-guide
 * background lines use yet another coordinate system on top of that - the
 * combination made the widget's on-screen position both wrong and
 * unreliable to click. A gutter marker renders in its own column, to the
 * left of `.cm-content` entirely, so none of that interacts with it.
 */
import { gutter, GutterMarker, type EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { parseTaskLine, findMetadataSpans } from '../../../../shared/tasks';

class AddMetadataMarker extends GutterMarker {
  constructor(readonly lineNumber: number) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof AddMetadataMarker && other.lineNumber === this.lineNumber;
  }

  toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'cm-task-add-metadata';
    span.setAttribute('data-task-line', String(this.lineNumber));
    span.title = 'Add due date, recurrence, or priority';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = 'add_circle';
    span.appendChild(icon);
    return span;
  }
}

export const taskAddMetadataGutter = gutter({
  class: 'cm-task-add-metadata-gutter',
  lineMarker(view, line) {
    const cursorLine = view.state.doc.lineAt(view.state.selection.main.from).number;
    const lineNumber = view.state.doc.lineAt(line.from).number;
    if (lineNumber !== cursorLine) return null;

    const lineText = view.state.doc.line(lineNumber).text;
    const parsed = parseTaskLine(lineText);
    if (!parsed) return null;

    const spans = findMetadataSpans(lineText).filter((s) => s.field !== 'completedAt');
    if (spans.length > 0) return null;

    return new AddMetadataMarker(lineNumber);
  },
  lineMarkerChange: (update: ViewUpdate) => update.docChanged || update.selectionSet,
  // Gutter clicks don't touch editable content, so there's no equivalent of
  // the checkbox's cursor-placement-vs-decoration-visibility race here - a
  // plain click handler is reliable.
  domEventHandlers: {
    // Matches the existing document-level CustomEvent pattern used by
    // imagePreview.ts's viewer-open request - a gutter's own click config
    // has no reach into React state, so it hands off via a DOM event that
    // Editor.tsx listens for instead.
    click: (_view: EditorView, _line, event: Event) => {
      const target = (event as MouseEvent).target as HTMLElement | null;
      const el = target?.closest?.('.cm-task-add-metadata') as HTMLElement | null;
      if (!el) return false;
      event.preventDefault();
      const lineNumber = Number(el.getAttribute('data-task-line'));
      if (!lineNumber) return false;
      document.dispatchEvent(
        new CustomEvent('phosphor-task-add-metadata', {
          detail: { lineNumber, anchorRect: el.getBoundingClientRect() },
          bubbles: true
        })
      );
      return true;
    }
  }
});

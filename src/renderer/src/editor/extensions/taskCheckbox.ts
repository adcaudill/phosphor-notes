import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { Range } from '@codemirror/state';
import { toggleTaskLine } from '../../../../shared/tasks';

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly status: 'todo' | 'doing' | 'done',
    readonly lineNumber: number,
    readonly widthCh: number,
    readonly view: EditorView
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return (
      other.status === this.status &&
      other.lineNumber === this.lineNumber &&
      other.widthCh === this.widthCh
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `cm-task-checkbox cm-task-${this.status}`;
    wrap.setAttribute('data-task-status', this.status);
    wrap.setAttribute('data-task-line', String(this.lineNumber));
    // Reserve the same horizontal space as the replaced characters so the
    // following text doesn't shift when we replace the marker with the
    // widget - structural/measured, so it stays inline rather than moving
    // to the stylesheet like everything else here.
    wrap.style.width = `${this.widthCh}ch`;

    // Two nested elements rather than one: the outer box's own size (set in
    // CSS as a fixed em value, independent of its content) is what
    // CodeMirror/the browser uses to size this line, while the inner glyph
    // can have a bigger font-size purely for its own painted appearance.
    // A single element sized via a bigger font-size (the original
    // approach) grows the LINE's rendered height to match; a `transform:
    // scale()` on that single element avoided the height problem but
    // scales from the box's own center, and since the box sits left-
    // aligned inside the wider reserved "- [ ] " space (not centered in
    // it), scaling made it drift further left rather than growing
    // symmetrically around where it visually belongs.
    const indicator = document.createElement('span');
    indicator.className = 'cm-task-checkbox-icon';

    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined cm-task-checkbox-glyph';
    glyph.textContent =
      this.status === 'todo'
        ? 'check_box_outline_blank'
        : this.status === 'doing'
          ? 'indeterminate_check_box'
          : 'check_box';
    indicator.appendChild(glyph);

    // This decoration is hidden whenever the cursor is on this line (see
    // buildDecorations below - deliberate, so raw markdown is editable on
    // focus). That means a plain click routed through Editor.tsx's
    // centralized domEventHandlers arrives too late: CodeMirror's own
    // mousedown handling places the cursor here first, which synchronously
    // triggers a decoration rebuild that removes this widget before the
    // click event even fires. pointerdown interception (stopping the event
    // before CodeMirror's default cursor-placement runs) is the only
    // reliable fix, so - unlike every other clickable widget in this
    // editor - the checkbox has to handle its own click rather than go
    // through the shared click router.
    indicator.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (indicator instanceof HTMLElement) {
        indicator.setPointerCapture((e as PointerEvent).pointerId);
      }
    });
    indicator.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      dispatchTaskToggle(this.view, this.lineNumber);
    });

    wrap.appendChild(indicator);

    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const taskCheckboxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const decorations: Range<Decoration>[] = [];
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.from).number;
      const taskRegex = /^\s*-\s*\[([ x/])\]\s*(.*?)$/;

      for (let lineNum = 1; lineNum <= view.state.doc.lines; lineNum++) {
        const line = view.state.doc.line(lineNum);
        const lineText = line.text;

        // Skip decorating the line where the cursor is (to allow editing)
        if (lineNum === cursorLine) {
          continue;
        }

        taskRegex.lastIndex = 0;
        const match = taskRegex.exec(lineText);
        if (!match) continue;

        const bracketIndex = match[0].indexOf('[');
        const taskStart = line.from + match.index + bracketIndex;
        const taskEnd = taskStart + 3; // Length of "[ ]", "[x]", or "[/]"

        const dashIndex = match[0].indexOf('-');
        const dashStart = dashIndex !== -1 ? line.from + match.index + dashIndex : taskStart;

        const status = match[1] === ' ' ? 'todo' : match[1] === '/' ? 'doing' : 'done';
        const widthCh = Math.max(1, taskEnd - dashStart);

        const widget = new TaskCheckboxWidget(status, lineNum, widthCh, view);
        decorations.push(
          Decoration.replace({
            widget,
            side: -1
          }).range(dashStart, taskEnd)
        );
      }

      return Decoration.set(decorations);
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

/**
 * The single call site that talks to the shared task-toggle logic
 * (todo -> doing -> done -> todo, including recurring-task completion) -
 * the checkbox widget's own click handler, the editor's `toggleTaskAtLine`
 * imperative handle (used by the Tasks view/daily rollup for the currently
 * open file), and the `Mod-Enter` keyboard shortcut all call this, so they
 * can never drift into different behaviors the way three separate
 * implementations used to.
 */
export function dispatchTaskToggle(view: EditorView, lineNumber: number): void {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return;
  const line = view.state.doc.line(lineNumber);
  const [firstLine, ...restLines] = toggleTaskLine(line.text);

  view.dispatch({
    changes:
      restLines.length === 0
        ? { from: line.from, to: line.to, insert: firstLine }
        : [
            { from: line.from, to: line.to, insert: firstLine },
            { from: line.to, insert: '\n' + restLines.join('\n') }
          ]
  });
}

// Task toggle command and keyboard shortcut handler (Mod-Enter)
export function cycleTaskStatus(view: EditorView): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);

  if (!/^\s*-\s*\[([ x/])\]/.test(line.text)) return false;

  dispatchTaskToggle(view, line.number);
  return true;
}

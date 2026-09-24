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
    readonly lineStart: number,
    readonly matchStart: number,
    readonly matchEnd: number,
    readonly dashStart: number,
    readonly onToggle: () => void
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `cm-task-checkbox cm-task-${this.status}`;
    wrap.setAttribute('data-task-status', this.status);
    wrap.style.alignItems = 'center';
    wrap.style.lineHeight = '1';
    // Reserve the same horizontal space as the replaced characters so the
    // following text doesn't shift left when we replace the marker with the widget.
    try {
      const replacedChars = Math.max(1, this.matchEnd - this.dashStart);
      wrap.style.width = `${replacedChars}ch`;
      // Nudge the widget slightly right to better match the visual position
      // of the original list marker in CodeMirror's indented layout.
      wrap.style.marginLeft = '0.6ch';
    } catch {
      // Fallback: don't set width if measurements fail
    }

    const indicator = document.createElement('span');
    indicator.className = 'material-symbols-outlined';
    // Map statuses to Material Symbols icon names
    const iconName =
      this.status === 'todo'
        ? 'check_box_outline_blank'
        : this.status === 'doing'
          ? 'indeterminate_check_box'
          : 'check_box';
    indicator.textContent = iconName;
    indicator.style.display = 'inline-flex';
    indicator.style.alignItems = 'center';
    indicator.style.justifyContent = 'center';
    indicator.style.verticalAlign = 'middle';
    indicator.style.marginRight = '0.5ch';
    indicator.style.marginLeft = '0';
    indicator.style.width = '1.4em';
    indicator.style.textAlign = 'center';
    indicator.style.cursor = 'pointer';
    indicator.style.fontSize = '1.4em';
    indicator.style.lineHeight = '1';
    indicator.style.color = 'var(--color-primary)';
    indicator.style.userSelect = 'none';

    // Use pointerdown to intercept before CodeMirror processes cursor movement
    indicator.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Capture the pointer to ensure we get the full sequence
      if (indicator instanceof HTMLElement) {
        indicator.setPointerCapture((e as PointerEvent).pointerId);
      }
    });

    indicator.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.onToggle();
    });

    wrap.appendChild(indicator);

    return wrap;
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

      // Iterate through all lines in the document
      for (let lineNum = 1; lineNum <= view.state.doc.lines; lineNum++) {
        const line = view.state.doc.line(lineNum);
        const lineText = line.text;

        // Skip decorating the line where the cursor is (to allow editing)
        if (lineNum === cursorLine) {
          continue;
        }

        // Use exec to get the match index
        taskRegex.lastIndex = 0;
        const match = taskRegex.exec(lineText);
        if (!match) continue;

        // Calculate bracket position within the matched text
        const bracketIndex = match[0].indexOf('[');
        const taskStart = line.from + match.index + bracketIndex;
        const taskEnd = taskStart + 3; // Length of "[ ]", "[x]", or "[/]"

        // Also find the leading dash in the matched text and include it in the
        // decoration range so the `-` is hidden beneath the widget.
        const dashIndex = match[0].indexOf('-');
        const dashStart = dashIndex !== -1 ? line.from + match.index + dashIndex : taskStart;

        const status = match[1] === ' ' ? 'todo' : match[1] === '/' ? 'doing' : 'done';

        const onToggle = (): void => {
          dispatchTaskToggle(view, line.from, line.to);
        };

        const widget = new TaskCheckboxWidget(
          status,
          line.from,
          taskStart,
          taskEnd,
          dashStart,
          onToggle
        );
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
 * both the checkbox widget's click handler and the `Mod-Enter` keyboard
 * shortcut go through this, so they can never drift into two different
 * behaviors the way they used to.
 */
function dispatchTaskToggle(view: EditorView, lineFrom: number, lineTo: number): void {
  const lineText = view.state.doc.sliceString(lineFrom, lineTo);
  const [firstLine, ...restLines] = toggleTaskLine(lineText);

  view.dispatch({
    changes:
      restLines.length === 0
        ? { from: lineFrom, to: lineTo, insert: firstLine }
        : [
            { from: lineFrom, to: lineTo, insert: firstLine },
            { from: lineTo, insert: '\n' + restLines.join('\n') }
          ]
  });
}

// Task toggle command and keyboard shortcut handler (Mod-Enter)
export function cycleTaskStatus(view: EditorView): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);

  if (!/^\s*-\s*\[([ x/])\]/.test(line.text)) return false;

  dispatchTaskToggle(view, line.from, line.to);
  return true;
}

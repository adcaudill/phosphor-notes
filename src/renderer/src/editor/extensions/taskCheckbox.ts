import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { Range } from '@codemirror/state';

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly status: 'todo' | 'doing' | 'done',
    readonly lineStart: number,
    readonly matchStart: number,
    readonly matchEnd: number,
    readonly onToggle: () => void
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `cm-task-checkbox cm-task-${this.status}`;
    wrap.setAttribute('data-task-status', this.status);

    // Use consistent circle indicators for all states
    let circleChar = '○'; // empty circle for todo
    if (this.status === 'doing') {
      circleChar = '◐'; // half-circle for doing
    } else if (this.status === 'done') {
      circleChar = '●'; // filled circle for done
    }

    const indicator = document.createElement('span');
    indicator.textContent = circleChar;
    indicator.style.display = 'inline-block';
    indicator.style.marginRight = '6px';
    indicator.style.marginLeft = '-24px';
    indicator.style.cursor = 'pointer';
    indicator.style.fontSize = '1.1em';
    indicator.style.lineHeight = '1';
    indicator.style.color = 'var(--color-primary)';
    indicator.style.fontWeight = 'bold';

    indicator.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
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

        const status = match[1] === ' ' ? 'todo' : match[1] === '/' ? 'doing' : 'done';

        const onToggle = (): void => {
          // Dispatch a task toggle when checkbox is clicked
          const nextBracket = status === 'todo' ? '[/]' : status === 'doing' ? '[x]' : '[ ]';
          view.dispatch({
            changes: {
              from: taskStart,
              to: taskEnd,
              insert: nextBracket
            }
          });
        };

        const widget = new TaskCheckboxWidget(status, line.from, taskStart, taskEnd, onToggle);
        decorations.push(
          Decoration.replace({
            widget,
            side: -1
          }).range(taskStart, taskEnd)
        );
      }

      return Decoration.set(decorations);
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

// Task toggle command and keyboard shortcut handler
export function cycleTaskStatus(view: EditorView): boolean {
  const { from } = view.state.selection.main;
  const lineStart = view.state.doc.lineAt(from).from;
  const lineEnd = view.state.doc.lineAt(from).to;
  const lineText = view.state.doc.sliceString(lineStart, lineEnd);

  // Check if this line contains a task checkbox
  const taskMatch = lineText.match(/^\s*-\s*\[([ x/])\]/);
  if (!taskMatch) return false;

  // Determine next status: todo → doing → done → todo
  const currentStatus = taskMatch[1];
  const nextBracket = currentStatus === ' ' ? '[/]' : currentStatus === '/' ? '[x]' : '[ ]';

  // Find the bracket position
  const bracketStart = lineStart + lineText.indexOf('[');
  const bracketEnd = bracketStart + 3;

  view.dispatch({
    changes: {
      from: bracketStart,
      to: bracketEnd,
      insert: nextBracket
    }
  });

  return true;
}

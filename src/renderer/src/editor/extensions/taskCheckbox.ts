import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { Range } from '@codemirror/state';
import { parseTaskMetadata, formatDate, addInterval } from '../../utils/taskParser';

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
          // Get the full line text to check for recurrence
          const fullLineText = view.state.doc.sliceString(line.from, line.to);
          const metadata = parseTaskMetadata(fullLineText);

          if (metadata.recurrence && metadata.dueDate) {
            // Handle recurring task
            const nextDate = addInterval(metadata.dueDate, metadata.recurrence);
            const nextDateStr = formatDate(nextDate);
            const currentDateStr = formatDate(metadata.dueDate);

            // Mark current line as done
            const nextBracket = '[x]';
            const currentLineReplacement = fullLineText.replace(/\[[ /x]\]/, nextBracket);

            // Create next occurrence
            let nextLineContent = fullLineText
              .replace(/\[[ x/]\]/, '[ ]')
              .replace(currentDateStr, nextDateStr);

            // Ensure it's reset to todo
            nextLineContent = nextLineContent.replace(/\[x\]/, '[ ]');

            // Dispatch changes: replace current line and insert new line below
            view.dispatch({
              changes: [
                {
                  from: line.from,
                  to: line.to,
                  insert: currentLineReplacement
                },
                {
                  from: line.to,
                  insert: '\n' + nextLineContent
                }
              ]
            });
          } else {
            // Regular task toggle: todo → doing → done → todo
            const nextBracket = status === 'todo' ? '[/]' : status === 'doing' ? '[x]' : '[ ]';
            view.dispatch({
              changes: {
                from: taskStart,
                to: taskEnd,
                insert: nextBracket
              }
            });
          }
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

  // Check if this is a recurring task
  const metadata = parseTaskMetadata(lineText);
  if (metadata.recurrence && metadata.dueDate) {
    // Handle recurring task completion
    const nextDate = addInterval(metadata.dueDate, metadata.recurrence);
    const nextDateStr = formatDate(nextDate);
    const currentDateStr = formatDate(metadata.dueDate);

    // Mark current line as done
    const currentLineReplacement = lineText.replace(/\[[ /x]\]/, '[x]');

    // Create next occurrence
    let nextLineContent = lineText.replace(/\[[ x/]\]/, '[ ]').replace(currentDateStr, nextDateStr);

    nextLineContent = nextLineContent.replace(/\[x\]/, '[ ]');

    // Dispatch changes: replace current line and insert new line below
    view.dispatch({
      changes: [
        {
          from: lineStart,
          to: lineEnd,
          insert: currentLineReplacement
        },
        {
          from: lineEnd,
          insert: '\n' + nextLineContent
        }
      ]
    });

    return true;
  }

  // Regular task toggle: todo → doing → done → todo
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

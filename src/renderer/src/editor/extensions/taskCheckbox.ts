import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { Range } from '@codemirror/state';
import {
  parseTaskMetadata,
  formatDate,
  addInterval,
  getCurrentTimestamp
} from '../../utils/taskParser';

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
          // Get the full line text to check for recurrence
          const fullLineText = view.state.doc.sliceString(line.from, line.to);
          const metadata = parseTaskMetadata(fullLineText);

          if (metadata.recurrence && metadata.dueDate) {
            // Handle recurring task
            const nextDate = addInterval(metadata.dueDate, metadata.recurrence);
            const nextDateStr = formatDate(nextDate);
            const currentDateStr = formatDate(metadata.dueDate);

            // Mark current line as done with timestamp
            const timestamp = getCurrentTimestamp();
            const nextBracket = '[x]';
            const currentLineReplacement = fullLineText
              .replace(/\[[ /x]\]/, nextBracket)
              .replace(/✓\s?\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/, '') // Remove old timestamp if exists
              .replace(/(.)$/, `✓ ${timestamp}$1`); // Add new timestamp at end

            // Create next occurrence
            let nextLineContent = fullLineText
              .replace(/\[[ x/]\]/, '[ ]')
              .replace(currentDateStr, nextDateStr)
              .replace(/✓\s?\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\s?/, ''); // Remove completion timestamp from new occurrence

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
            let replacement = nextBracket;

            // Add timestamp when marking as done
            if (status === 'doing' && nextBracket === '[x]') {
              const timestamp = getCurrentTimestamp();
              replacement = `[x] ✓ ${timestamp}`;
              // Also update the line text to include the timestamp
              const lineText = view.state.doc.sliceString(line.from, line.to);
              const updated = lineText.replace(/\[[ /x]\]/, replacement);
              view.dispatch({
                changes: {
                  from: line.from,
                  to: line.to,
                  insert: updated
                }
              });
              return;
            }

            // If transitioning from done to todo, remove the timestamp
            if (status === 'done' && nextBracket === '[ ]') {
              const lineText = view.state.doc.sliceString(line.from, line.to);
              const updated = lineText
                .replace(/\[x\]\s*✓\s?\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/, '[ ]')
                .replace(/✓\s?\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/, '');
              view.dispatch({
                changes: {
                  from: line.from,
                  to: line.to,
                  insert: updated
                }
              });
              return;
            }

            view.dispatch({
              changes: {
                from: taskStart,
                to: taskEnd,
                insert: replacement
              }
            });
          }
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

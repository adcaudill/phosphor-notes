/**
 * Renders a task line's due date, recurrence, and priority metadata as
 * themed pill widgets - replacing the raw emoji/text (not just decorating
 * alongside it, which is what this file's predecessor, dateIndicator.ts,
 * used to do and which caused the raw text and the pill to both be
 * visible). The "add metadata" affordance for a bare task line with none
 * yet lives in a separate extension, taskAddMetadataGutter.ts (a gutter
 * marker, not an inline widget - see that file for why). Clicking a pill
 * is handled centrally in Editor.tsx's domEventHandlers, which opens
 * <TaskMetadataPopover /> - this file only renders, it never mutates the
 * document itself.
 */
import { ViewPlugin, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Range } from '@codemirror/state';
import { parseTaskLine, findMetadataSpans, type TaskMetadataSpan } from '../../../../shared/tasks';
import { PRIORITY_ICON, PRIORITY_LABEL, dueDateLabel, recurrenceLabel } from '../../utils/taskDisplay';

class TaskPillWidget extends WidgetType {
  constructor(
    readonly field: TaskMetadataSpan['field'],
    readonly icon: string,
    readonly label: string,
    readonly statusClass: string,
    readonly lineNumber: number
  ) {
    super();
  }

  eq(other: TaskPillWidget): boolean {
    return (
      other.field === this.field &&
      other.label === this.label &&
      other.statusClass === this.statusClass &&
      other.lineNumber === this.lineNumber
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-task-pill cm-task-pill-${this.field} ${this.statusClass}`;
    span.setAttribute('data-task-line', String(this.lineNumber));
    span.setAttribute('data-task-field', this.field);
    span.title = this.label;

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined cm-task-pill-icon';
    icon.textContent = this.icon;
    span.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'cm-task-pill-label';
    text.textContent = this.label;
    span.appendChild(text);

    return span;
  }
}

export const taskMetadataWidgetsPlugin = ViewPlugin.fromClass(
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
      const decorations: Range<Decoration>[] = [];

      for (let lineNum = 1; lineNum <= view.state.doc.lines; lineNum++) {
        const line = view.state.doc.line(lineNum);
        const parsed = parseTaskLine(line.text);
        if (!parsed) continue;

        const spans = findMetadataSpans(line.text).filter((s) => s.field !== 'completedAt');

        for (const span of spans) {
          let icon = '';
          let label = '';
          let statusClass = '';

          if (span.field === 'priority' && parsed.priority) {
            icon = PRIORITY_ICON[parsed.priority];
            label = PRIORITY_LABEL[parsed.priority];
            statusClass = `cm-task-pill-priority-${parsed.priority}`;
          } else if (span.field === 'due' && parsed.dueDate) {
            const { text, status } = dueDateLabel(parsed.dueDate);
            icon = 'calendar_today';
            label = text;
            statusClass = `cm-task-pill-date-${status}`;
          } else if (span.field === 'recurrence' && parsed.recurrence) {
            icon = 'repeat';
            label = recurrenceLabel(
              parsed.recurrence.amount,
              parsed.recurrence.unit,
              parsed.recurrence.supported
            );
            statusClass = parsed.recurrence.supported ? '' : 'cm-task-pill-unsupported';
          } else {
            continue;
          }

          const widget = new TaskPillWidget(span.field, icon, label, statusClass, lineNum);
          decorations.push(
            Decoration.replace({ widget }).range(line.from + span.start, line.from + span.end)
          );
        }
      }

      return Decoration.set(decorations, true);
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

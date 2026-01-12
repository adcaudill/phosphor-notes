/**
 * CodeMirror extension for displaying date pills with color coding
 * Shows due dates with visual indicators for urgency (overdue/today/upcoming)
 */

import { ViewPlugin, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Range } from '@codemirror/state';
import { isPast, isToday } from '../../utils/taskParser';

class DatePillWidget extends WidgetType {
  constructor(
    readonly dateStr: string,
    readonly status: 'overdue' | 'today' | 'future'
  ) {
    super();
  }

  eq(other: DatePillWidget): boolean {
    return other.dateStr === this.dateStr && other.status === this.status;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `task-date-pill task-date-${this.status}`;
    span.textContent = this.dateStr;
    span.style.display = 'inline-block';
    span.style.padding = '2px 6px';
    span.style.borderRadius = '4px';
    span.style.fontSize = '0.9em';
    span.style.marginLeft = '4px';
    span.style.cursor = 'default';
    span.style.userSelect = 'none';

    // Color coding based on status
    if (this.status === 'overdue') {
      span.style.backgroundColor = '#fee2e2';
      span.style.color = '#991b1b';
      span.style.fontWeight = '600';
    } else if (this.status === 'today') {
      span.style.backgroundColor = '#fef3c7';
      span.style.color = '#92400e';
      span.style.fontWeight = '600';
    } else {
      span.style.backgroundColor = '#e0f2fe';
      span.style.color = '#0c4a6e';
    }

    return span;
  }
}

export const dateIndicatorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const decorations: Range<Decoration>[] = [];
      const dateRegex = /📅\s?(\d{4}-\d{2}-\d{2})/g;

      // Iterate through all lines
      for (let lineNum = 1; lineNum <= view.state.doc.lines; lineNum++) {
        const line = view.state.doc.line(lineNum);
        const lineText = line.text;

        // Check if this is a task line
        if (!lineText.match(/^\s*-\s*\[/)) {
          continue;
        }

        // Find all dates in this line
        const matches = [...lineText.matchAll(dateRegex)];
        for (const match of matches) {
          const dateStr = match[1];
          const dateObj = new Date(dateStr + 'T00:00:00Z');

          // Determine status
          let status: 'overdue' | 'today' | 'future' = 'future';
          if (isPast(dateObj)) {
            status = 'overdue';
          } else if (isToday(dateObj)) {
            status = 'today';
          }

          // Create widget
          const widget = new DatePillWidget(dateStr, status);

          // Position: right after the date emoji and string
          const dateStart = line.from + match.index;
          const dateEnd = dateStart + match[0].length;

          decorations.push(
            Decoration.widget({
              widget,
              side: 1 // After the matched text
            }).range(dateEnd)
          );
        }
      }

      return Decoration.set(decorations);
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

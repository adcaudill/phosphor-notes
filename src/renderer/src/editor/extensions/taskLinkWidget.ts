/**
 * Renders task links - `[[_task:<id>|<title>]]` - as a live task widget: a
 * checkbox that completes/reopens the task in place, the task's current
 * title (from the task index, not the link text), and pills for its due
 * date, repeat and priority. Clicking the title asks the app to open the
 * task (a `phosphor-open-task` DOM event with `{ id }`).
 *
 * The widget is atomic: the cursor steps over it, and Backspace removes the
 * whole link (never the task - tasks are independent of the notes linking
 * them). It re-renders whenever the task index changes.
 *
 * Layout follows the inline-task work: the checkbox uses the same 1em box
 * and em-based vertical offset as `.cm-task-checkbox`, and every widget
 * element resets the inherited `text-indent` (the outliner's hanging indent
 * would otherwise pull its contents out of place).
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { TASK_LINK_RE } from '../../../../shared/taskLinks';
import { editorColumns } from './editorColumns';
import { localDate, type TaskStatus } from '../../../../shared/taskRecord';
import { describeRepeat } from '../../../../shared/taskRepeat';
import type { TaskSummary } from '../../../../shared/taskViews';
import {
  getTaskSummary,
  isTaskRecordsReady,
  subscribeTaskRecords
} from '../../tasks/taskRecordsStore';
import { PRIORITY_ICON, PRIORITY_LABEL, friendlyDueLabel } from '../../utils/taskDisplay';

/** Dispatched on the editor when the task index changed, to rebuild the widgets. */
const taskRecordsChanged = StateEffect.define<null>();

type WidgetState =
  | { kind: 'loading'; title: string }
  | { kind: 'missing'; title: string }
  | {
      kind: 'task';
      title: string;
      status: TaskStatus;
      due?: string;
      repeat?: string;
      priority?: TaskSummary['priority'];
    };

const STATUS_GLYPH: Record<TaskStatus, string> = {
  todo: 'check_box_outline_blank',
  doing: 'indeterminate_check_box',
  waiting: 'pending',
  done: 'check_box',
  cancelled: 'disabled_by_default'
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  doing: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
  cancelled: 'Cancelled'
};

function stateFor(id: string, linkTitle: string): WidgetState {
  if (!isTaskRecordsReady()) return { kind: 'loading', title: linkTitle || 'Task' };
  const task = getTaskSummary(id);
  if (!task) return { kind: 'missing', title: linkTitle };
  return {
    kind: 'task',
    title: task.title,
    status: task.status,
    due: task.due,
    repeat: task.repeat ? describeRepeat(task.repeat) : undefined,
    priority: task.priority
  };
}

/** Completes an open task, or reopens a finished one. */
async function toggleTask(id: string, status: TaskStatus): Promise<void> {
  const api = window.phosphor?.taskRecords;
  if (!api) return;
  try {
    if (status === 'done' || status === 'cancelled') await api.update(id, { status: 'todo' });
    else await api.complete(id);
  } catch (err) {
    console.error('[Tasks] failed to update task', id, err);
  }
}

function pill(classes: string, icon: string, label: string, title = label): HTMLElement {
  const el = document.createElement('span');
  el.className = `cm-task-pill ${classes}`;
  el.title = title;
  const i = document.createElement('span');
  i.className = 'material-symbols-outlined cm-task-pill-icon';
  i.textContent = icon;
  const t = document.createElement('span');
  t.className = 'cm-task-pill-label';
  t.textContent = label;
  el.append(i, t);
  return el;
}

class TaskLinkWidget extends WidgetType {
  private readonly key: string;

  /**
   * @param bulletColumns When the link is a bullet's whole lead-in
   *   (`- [[_task:...]]`), the widget also covers the `- ` and its checkbox
   *   takes exactly those columns: the checkbox lands in the dash column, the
   *   title in the sibling bullets' text column, and the bullet's hanging
   *   indent lines wrapped rows up under the title. 0 for a link mid-text.
   */
  constructor(
    readonly id: string,
    readonly state: WidgetState,
    readonly bulletColumns = 0
  ) {
    super();
    this.key = `${bulletColumns}|${JSON.stringify(state)}`;
  }

  eq(other: TaskLinkWidget): boolean {
    return other.id === this.id && other.key === this.key;
  }

  toDOM(): HTMLElement {
    const s = this.state;
    const root = document.createElement('span');
    root.className = `cm-task-link cm-task-link-${s.kind === 'task' ? s.status : s.kind}`;
    root.setAttribute('data-task-id', this.id);

    const check = document.createElement('span');
    check.className = 'cm-task-link-check';
    if (this.bulletColumns > 0) {
      // Replaces the bullet's "- ": take exactly its width (see the constructor).
      root.classList.add('cm-task-link-bullet');
      check.style.width = editorColumns(this.bulletColumns);
    }
    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined cm-task-link-glyph';
    check.appendChild(glyph);

    const title = document.createElement('span');
    title.className = 'cm-task-link-title';

    if (s.kind === 'task') {
      glyph.textContent = STATUS_GLYPH[s.status];
      check.setAttribute('role', 'checkbox');
      check.setAttribute('aria-checked', s.status === 'done' ? 'true' : 'false');
      check.title = `${STATUS_LABEL[s.status]} - click to ${
        s.status === 'done' || s.status === 'cancelled' ? 'reopen' : 'complete'
      }`;
      // Handle the click here, before CodeMirror moves the cursor (see taskCheckbox.ts).
      check.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      check.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggleTask(this.id, s.status);
      });
      title.textContent = s.title;
      title.title = 'Open task';
    } else if (s.kind === 'missing') {
      glyph.textContent = 'link_off';
      check.title = 'This task no longer exists';
      title.textContent = s.title ? `Missing task: ${s.title}` : 'Missing task';
      title.title = 'This task no longer exists';
    } else {
      glyph.textContent = 'check_box_outline_blank';
      title.textContent = s.title;
    }

    if (s.kind !== 'loading') {
      title.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      title.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        root.dispatchEvent(
          new CustomEvent('phosphor-open-task', { bubbles: true, detail: { id: this.id } })
        );
      });
    }

    root.append(check, title);

    if (s.kind === 'task' && s.status !== 'done' && s.status !== 'cancelled') {
      if (s.due) {
        const due = friendlyDueLabel(s.due, localDate());
        root.append(
          pill(
            `cm-task-pill-due cm-task-pill-date-${due.status}`,
            'calendar_today',
            due.text,
            `Due ${s.due}`
          )
        );
      }
      if (s.repeat) root.append(pill('cm-task-pill-recurrence', 'repeat', s.repeat));
      if (s.priority) {
        root.append(
          pill(
            `cm-task-pill-priority cm-task-pill-priority-${s.priority}`,
            PRIORITY_ICON[s.priority],
            PRIORITY_LABEL[s.priority]
          )
        );
      }
    }
    return root;
  }

  ignoreEvent(): boolean {
    // The widget handles its own clicks; CodeMirror shouldn't move the cursor into it.
    return true;
  }
}

/** A bullet marker and its spacing at the start of a line: "    - ". Group 1 is the indentation. */
const BULLET_LEAD_RE = /^(\s*)-\s+$/;

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = new RegExp(TASK_LINK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let start = from + m.index;
      const end = start + m[0].length;
      // A link that is the bullet's lead-in takes over the "- " too.
      const line = view.state.doc.lineAt(start);
      const lead = BULLET_LEAD_RE.exec(view.state.doc.sliceString(line.from, start));
      let bulletColumns = 0;
      if (lead) {
        const dash = line.from + lead[1].length;
        bulletColumns = start - dash;
        start = dash;
      }
      builder.add(
        start,
        end,
        Decoration.replace({
          widget: new TaskLinkWidget(m[1], stateFor(m[1], (m[2] ?? '').trim()), bulletColumns)
        })
      );
    }
  }
  return builder.finish();
}

const taskLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private unsubscribe: () => void;
    private destroyed = false;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
      this.unsubscribe = subscribeTaskRecords(() => {
        // Can't dispatch from inside an update; defer to the next tick.
        queueMicrotask(() => {
          if (!this.destroyed) view.dispatch({ effects: taskRecordsChanged.of(null) });
        });
      });
    }

    update(update: ViewUpdate): void {
      const changed = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(taskRecordsChanged))
      );
      if (update.docChanged || update.viewportChanged || changed) {
        this.decorations = buildDecorations(update.view);
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.unsubscribe();
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
  }
);

export const taskLinkExtension = [taskLinkPlugin];

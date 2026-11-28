/**
 * The Tasks tab: task files (`_tasks/`) as a task manager.
 *
 *   views | list (calendar strip, search, group, sort, quick add) | detail panel
 *
 * Views: Inbox, Today, Upcoming, Anytime, Waiting, Scheduled, Logbook, All;
 * a view per project and per tag (open tasks); saved views (named searches,
 * stored in the vault); "Checklist items" (inline `- [ ]` tasks in notes,
 * until they're converted); and Problems (task files that couldn't be read).
 *
 * Search takes free text (full-text across title, notes, checklist,
 * comments) and filters like `due:<7d #bills +Home status:waiting` (see
 * shared/taskQuery.ts). In a project, tag or saved view it searches within
 * that view; elsewhere it searches every task.
 *
 * Several tasks can be picked (⌘-click, ⇧-click, X) for bulk changes. With
 * "Manual" sorting, rows can be dragged (or moved with ⌥↑/↓) into order. In
 * Today and Upcoming, a calendar strip shows the next two weeks: click a day
 * to see it, drop tasks on a day to reschedule them.
 *
 * Keyboard (list focused): J/K or arrows move; Space completes or reopens;
 * Enter opens the detail panel; E edits the title; D/S/R/T edit due, start,
 * repeat, tags (J for project, from the panel); X picks; N adds; / searches;
 * G then I/T/U/A/W/S/L/C jumps to a view; ? lists the shortcuts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SavedTaskView, TaskSummary } from '../../../shared/taskViews';
import {
  TASK_VIEWS,
  groupTasks,
  inView,
  isOpen,
  parseTaskFilter,
  planReorder,
  sortTasks,
  viewCounts,
  type TaskGroup,
  type TaskSort,
  type TaskViewId
} from '../../../shared/taskQuery';
import { localDate, type TaskPriority, type TaskStatus } from '../../../shared/taskRecord';
import { addDays, describeRepeat } from '../../../shared/taskRepeat';
import { parseDatePhrase } from '../../../shared/taskParse';
import type { NewTaskInput, TaskPatch } from '../../../shared/taskOps';
import { useTaskRecords } from '../tasks/taskRecordsStore';
import { friendlyDueLabel, PRIORITY_ICON, PRIORITY_LABEL } from '../utils/taskDisplay';
import { TaskDetail } from './TaskDetail';
import { TaskCapture } from './TaskCapture';
import '../styles/TaskManager.css';

type ViewId =
  TaskViewId | 'checklist' | 'problems' | `project:${string}` | `tag:${string}` | `saved:${string}`;

type Scope =
  | { kind: 'builtin'; id: TaskViewId }
  | { kind: 'project'; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'saved'; id: string }
  | { kind: 'checklist' }
  | { kind: 'problems' };

function scopeOf(view: ViewId): Scope {
  if (view === 'checklist' || view === 'problems') return { kind: view };
  if (view.startsWith('project:')) return { kind: 'project', name: view.slice(8) };
  if (view.startsWith('tag:')) return { kind: 'tag', name: view.slice(4) };
  if (view.startsWith('saved:')) return { kind: 'saved', id: view.slice(6) };
  return { kind: 'builtin', id: view as TaskViewId };
}

export interface TaskManagerProps {
  /** Rendered for the "Checklist items" view: inline checkbox tasks in notes. */
  checklistView: React.ReactNode;
  checklistCount: number;
  /** Inline checkbox tasks with metadata (dates, repeats, priority) that could become task files. */
  convertibleCount: number;
  /** Opens the conversion preview for the whole vault. */
  onConvert: () => void;
  onNavigate: (note: string, line: number) => void;
}

const STORAGE_KEY = 'phosphor.tasks.prefs';

interface Prefs {
  view: ViewId;
  group: TaskGroup;
  sort: TaskSort;
}

function loadPrefs(): Prefs {
  try {
    return {
      view: 'today',
      group: 'due',
      sort: 'due',
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    };
  } catch {
    return { view: 'today', group: 'due', sort: 'due' };
  }
}

const VIEW_KEYS: Record<string, ViewId> = {
  i: 'inbox',
  t: 'today',
  u: 'upcoming',
  a: 'anytime',
  w: 'waiting',
  s: 'scheduled',
  l: 'logbook',
  c: 'checklist'
};

const SHORTCUTS: Array<[string, string]> = [
  ['J / K, ↓ / ↑', 'Move through the list'],
  ['Space', 'Complete or reopen (every picked task, if any)'],
  ['Enter', 'Open the task'],
  ['E', 'Edit the title'],
  ['D / S / R / T', 'Edit due, start, repeat, tags'],
  ['Enter, then J', 'Edit the project (in the task panel)'],
  ['X, ⌘-click, ⇧-click', 'Pick tasks for bulk changes'],
  ['⌥↑ / ⌥↓', 'Move the task up or down (Manual sorting)'],
  ['N', 'New task'],
  ['/', 'Search'],
  [
    'G then I T U A W S L C',
    'Go to Inbox, Today, Upcoming, Anytime, Waiting, Scheduled, Logbook, Checklist items'
  ],
  ['Esc', 'Clear the picked tasks, close the task, clear the search'],
  ['?', 'Show these shortcuts']
];

const DRAG_TYPE = 'application/x-phosphor-tasks';
const STRIP_DAYS = 14;

function TaskRow({
  task,
  selected,
  picked,
  today,
  dropTarget,
  onSelect,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop
}: {
  task: TaskSummary;
  selected: boolean;
  picked: boolean;
  today: string;
  /** Show the drop marker above this row (manual ordering). */
  dropTarget: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}): React.JSX.Element {
  const finished = task.status === 'done' || task.status === 'cancelled';
  const due = task.due ? friendlyDueLabel(task.due, today) : null;
  const doneSteps = task.checklist.filter((c) => c.done).length;
  const icon =
    task.status === 'done'
      ? 'check_box'
      : task.status === 'cancelled'
        ? 'disabled_by_default'
        : task.status === 'doing'
          ? 'indeterminate_check_box'
          : task.status === 'waiting'
            ? 'pending'
            : 'check_box_outline_blank';
  return (
    <li
      className={`task-row status-${task.status} ${selected ? 'selected' : ''} ${picked ? 'picked' : ''} ${dropTarget ? 'drop-before' : ''}`}
      data-task-id={task.id}
      onClick={onSelect}
      aria-selected={selected || picked}
      role="option"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="task-row-check material-symbols-outlined"
        title={finished ? 'Reopen' : 'Complete'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {icon}
      </button>
      <span className="task-row-main">
        <span className="task-row-title">{task.title}</span>
        <span className="task-row-meta">
          {due && !finished && (
            <span className={`task-row-pill due-${due.status}`}>
              <span className="material-symbols-outlined">calendar_today</span>
              {due.text}
            </span>
          )}
          {task.repeat && (
            <span className="task-row-pill repeat" title={describeRepeat(task.repeat)}>
              <span className="material-symbols-outlined">repeat</span>
              {describeRepeat(task.repeat)}
            </span>
          )}
          {task.priority && !finished && (
            <span
              className={`task-row-pill priority-${task.priority}`}
              title={PRIORITY_LABEL[task.priority]}
            >
              <span className="material-symbols-outlined">{PRIORITY_ICON[task.priority]}</span>
            </span>
          )}
          {task.waitingOn && <span className="task-row-note">waiting on {task.waitingOn}</span>}
          {task.checklist.length > 0 && (
            <span className="task-row-note">
              <span className="material-symbols-outlined">checklist</span>
              {doneSteps}/{task.checklist.length}
            </span>
          )}
          {task.hasNotes && (
            <span className="task-row-note material-symbols-outlined" title="Has notes">
              notes
            </span>
          )}
          {task.commentCount > 0 && (
            <span className="task-row-note" title={`${task.commentCount} comments`}>
              <span className="material-symbols-outlined">chat_bubble</span>
              {task.commentCount}
            </span>
          )}
          {task.project && <span className="task-row-project">{task.project}</span>}
          {task.tags.map((t) => (
            <span key={t} className="task-row-tag">
              #{t}
            </span>
          ))}
        </span>
      </span>
    </li>
  );
}

/** Distinct values (first spelling wins, case-insensitively) with open-task counts. */
function tally(values: string[]): Array<{ name: string; count: number }> {
  const byKey = new Map<string, { name: string; count: number }>();
  for (const v of values) {
    const key = v.toLowerCase();
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { name: v, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A new due value for `day`, keeping the task's time of day if it had one. */
function rescheduled(task: TaskSummary, day: string): string {
  return task.due && task.due.length > 10 ? `${day}${task.due.slice(10)}` : day;
}

function shortDay(day: string): { weekday: string; date: string } {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return {
    weekday: dt.toLocaleDateString(undefined, { weekday: 'short' }),
    date: String(d)
  };
}

function BulkBar({
  count,
  onApply,
  onComplete,
  onDelete,
  onClear
}: {
  count: number;
  onApply: (patch: (t: TaskSummary) => TaskPatch | null) => void;
  onComplete: () => void;
  onDelete: () => void;
  onClear: () => void;
}): React.JSX.Element {
  const [due, setDue] = useState('');
  const [dueError, setDueError] = useState(false);
  const [project, setProject] = useState('');
  const [tag, setTag] = useState('');
  return (
    <div className="task-manager-bulk" role="toolbar" aria-label="Change picked tasks">
      <strong>{count} picked</strong>
      <button type="button" onClick={onComplete}>
        <span className="material-symbols-outlined">check</span>
        Complete
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = due.trim();
          if (!text) return;
          const d = text === 'none' ? null : parseDatePhrase(text);
          if (d === null && text !== 'none') {
            setDueError(true);
            return;
          }
          onApply(() => ({ due: d }));
          setDue('');
        }}
      >
        <input
          value={due}
          className={dueError ? 'invalid' : ''}
          placeholder="Due: fri, dec 4, none"
          aria-label="Set due date"
          onChange={(e) => {
            setDue(e.target.value);
            setDueError(false);
          }}
        />
      </form>
      <select
        aria-label="Set priority"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onApply(() => ({ priority: v === 'none' ? null : (v as TaskPriority) }));
        }}
      >
        <option value="">Priority…</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
        <option value="none">None</option>
      </select>
      <select
        aria-label="Set status"
        value=""
        onChange={(e) => {
          const v = e.target.value as TaskStatus | '';
          if (!v) return;
          onApply(() => ({ status: v }));
        }}
      >
        <option value="">Status…</option>
        <option value="todo">To do</option>
        <option value="doing">Doing</option>
        <option value="waiting">Waiting</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const p = project.trim().replace(/^\+/, '');
          onApply(() => ({ project: p === '' || p === 'none' ? null : p }));
          setProject('');
        }}
      >
        <input
          value={project}
          placeholder="Project"
          aria-label="Set project"
          onChange={(e) => setProject(e.target.value)}
        />
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = tag.trim().replace(/^#/, '');
          if (!t) return;
          onApply((task) =>
            task.tags.some((x) => x.toLowerCase() === t.toLowerCase())
              ? null
              : { tags: [...task.tags, t] }
          );
          setTag('');
        }}
      >
        <input
          value={tag}
          placeholder="Add tag"
          aria-label="Add a tag"
          onChange={(e) => setTag(e.target.value)}
        />
      </form>
      <button type="button" className="danger" onClick={onDelete}>
        <span className="material-symbols-outlined">delete</span>
        Delete
      </button>
      <button type="button" onClick={onClear} title="Clear (Esc)">
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>
  );
}

export function TaskManager({
  checklistView,
  checklistCount,
  convertibleCount,
  onConvert,
  onNavigate
}: TaskManagerProps): React.JSX.Element {
  const { ready, tasks, problems } = useTaskRecords();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [query, setQuery] = useState('');
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Tasks picked for bulk changes.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  // A day picked in the calendar strip ('overdue' for everything before today).
  const [day, setDay] = useState<string | null>(null);
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedTaskView[]>([]);
  // Naming a new saved view: the name typed so far, or null when not naming.
  const [naming, setNaming] = useState<string | null>(null);
  // Open quick-add: where to anchor it (null = centered), or false when closed.
  const [capturing, setCapturing] = useState<DOMRect | null | false>(false);
  const openCapture = (): void => setCapturing(addRef.current?.getBoundingClientRect() ?? null);
  const [showHelp, setShowHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const pendingG = useRef(false);
  const today = localDate();
  const api = window.phosphor.taskRecords;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  // Saved views live in the vault; reload them whenever the task list (re)loads.
  useEffect(() => {
    if (!ready) return;
    let current = true;
    api
      .getSavedViews()
      .then((v) => {
        if (current) setSavedViews(v);
      })
      .catch((err) => console.error('[Tasks] could not read saved views', err));
    return () => {
      current = false;
    };
  }, [api, ready]);

  const view = prefs.view;
  const scope = scopeOf(view);
  const saved = scope.kind === 'saved' ? savedViews.find((v) => v.id === scope.id) : undefined;
  const group = saved?.group ?? prefs.group;
  const sort = saved?.sort ?? prefs.sort;
  const builtin = scope.kind === 'builtin' ? scope.id : undefined;

  // A saved view's own search, plus whatever is typed on top of it.
  const effectiveQuery = saved ? `${saved.query} ${query}` : query;
  const filter = useMemo(() => parseTaskFilter(effectiveQuery), [effectiveQuery]);

  // Free text goes to the full-text index in the main process.
  useEffect(() => {
    if (!filter.text) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api.search(filter.text).then((ids) => {
        if (current) setSearchIds(new Set(ids));
      });
    }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, filter.text, tasks]);

  const searching = query.trim().length > 0;
  const counts = useMemo(() => viewCounts(tasks, today), [tasks, today]);
  const openTasks = useMemo(() => tasks.filter(isOpen), [tasks]);
  const projects = useMemo(
    () => tally(openTasks.flatMap((t) => (t.project ? [t.project] : []))),
    [openTasks]
  );
  const tags = useMemo(() => tally(openTasks.flatMap((t) => t.tags)), [openTasks]);

  const showStrip = !searching && (builtin === 'today' || builtin === 'upcoming');
  const stripDays = useMemo(
    () => Array.from({ length: STRIP_DAYS }, (_, i) => addDays(today, i)),
    [today]
  );
  const dueCounts = useMemo(() => {
    const m = new Map<string, number>();
    let overdue = 0;
    for (const t of openTasks) {
      const d = t.due?.slice(0, 10);
      if (!d) continue;
      if (d < today) overdue += 1;
      else m.set(d, (m.get(d) ?? 0) + 1);
    }
    return { byDay: m, overdue };
  }, [openTasks, today]);

  const visible = useMemo(() => {
    if (scope.kind === 'checklist' || scope.kind === 'problems') return [];
    let pool: TaskSummary[];
    if (showStrip && day) {
      // A day picked in the strip: every open task due that day.
      pool = openTasks.filter((t) => {
        const d = t.due?.slice(0, 10);
        return d !== undefined && (day === 'overdue' ? d < today : d === day);
      });
    } else if (scope.kind === 'project') {
      const name = scope.name.toLowerCase();
      pool = openTasks.filter((t) => t.project?.toLowerCase() === name);
    } else if (scope.kind === 'tag') {
      const name = scope.name.toLowerCase();
      pool = openTasks.filter((t) => t.tags.some((x) => x.toLowerCase() === name));
    } else if (scope.kind === 'saved') {
      pool = saved ? tasks : [];
    } else {
      // A search from a built-in view looks across every task.
      pool = searching ? tasks : tasks.filter((t) => inView(t, scope.id, today));
    }
    const matched = pool.filter(
      (t) => filter.test(t, { today }) && (!filter.text || (searchIds?.has(t.id) ?? false))
    );
    return sortTasks(matched, sort, searching ? undefined : builtin);
    // scope is derived from view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, openTasks, view, saved, searching, filter, searchIds, sort, today, showStrip, day]);

  const groups = useMemo(
    () => groupTasks(visible, group, today, searching || day ? undefined : builtin),
    [visible, group, today, searching, day, builtin]
  );
  const ordered = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const pickedTasks = useMemo(
    () => [...picked].map((id) => byId.get(id)).filter((t): t is TaskSummary => Boolean(t)),
    [picked, byId]
  );

  const fail = (what: string, err: unknown): void => {
    console.error(`[Tasks] ${what} failed`, err);
    setError(`Couldn't ${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const select = (id: string | null): void => {
    setSelectedId(id);
    if (id) {
      requestAnimationFrame(() =>
        listRef.current
          ?.querySelector(`[data-task-id="${id}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      );
    }
  };

  const togglePick = (id: string): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onRowClick = (t: TaskSummary, e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey) {
      // Starting a pick from a selected task picks that one too.
      setPicked((p) => {
        const next = new Set(p);
        if (p.size === 0 && selectedId && selectedId !== t.id) next.add(selectedId);
        if (next.has(t.id)) next.delete(t.id);
        else next.add(t.id);
        return next;
      });
      return;
    }
    if (e.shiftKey && selectedId) {
      const a = ordered.findIndex((x) => x.id === selectedId);
      const b = ordered.findIndex((x) => x.id === t.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setPicked(new Set(ordered.slice(lo, hi + 1).map((x) => x.id)));
        return;
      }
    }
    setPicked(new Set());
    select(t.id);
  };

  const toggle = async (t: TaskSummary): Promise<void> => {
    try {
      if (t.status === 'done' || t.status === 'cancelled')
        await api.update(t.id, { status: 'todo' });
      else await api.complete(t.id);
    } catch (err) {
      fail('update the task', err);
    }
  };

  /** Apply a change to several tasks; `patchFor` returns null to leave one alone. */
  const applyAll = async (
    list: TaskSummary[],
    patchFor: (t: TaskSummary) => TaskPatch | null
  ): Promise<void> => {
    const results = await Promise.allSettled(
      list.map((t) => {
        const patch = patchFor(t);
        return patch ? api.update(t.id, patch) : Promise.resolve(null);
      })
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length)
      fail(`change ${failed.length} of them`, (failed[0] as PromiseRejectedResult).reason);
  };

  const completeAll = async (list: TaskSummary[]): Promise<void> => {
    const allFinished = list.every((t) => !isOpen(t));
    const results = await Promise.allSettled(
      list.map((t) =>
        allFinished ? api.update(t.id, { status: 'todo' }) : isOpen(t) ? api.complete(t.id) : null
      )
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length)
      fail(`complete ${failed.length} of them`, (failed[0] as PromiseRejectedResult).reason);
  };

  const deleteAll = async (list: TaskSummary[]): Promise<void> => {
    const linked = list.filter((t) => t.linkCount > 0).length;
    const message =
      `Delete ${list.length} task${list.length === 1 ? '' : 's'}?` +
      (linked
        ? ` ${linked} ${linked === 1 ? 'is' : 'are'} linked from notes; those links will show as missing.`
        : '') +
      ' Deleted tasks can be restored from history.';
    if (!window.confirm(message)) return;
    const results = await Promise.allSettled(list.map((t) => api.delete(t.id)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length)
      fail(`delete ${failed.length} of them`, (failed[0] as PromiseRejectedResult).reason);
    setPicked(new Set());
    if (selectedId && list.some((t) => t.id === selectedId)) setSelectedId(null);
  };

  /** Manual ordering: move `id` to just before `beforeId` (null = to the end) within its group. */
  const moveTask = async (id: string, beforeId: string | null): Promise<void> => {
    const section = groups.find((g) => g.tasks.some((t) => t.id === id));
    if (!section) return;
    const from = section.tasks.findIndex((t) => t.id === id);
    let to =
      beforeId === null
        ? section.tasks.length - 1
        : section.tasks.findIndex((t) => t.id === beforeId);
    if (to < 0) return; // dropped in another group
    if (beforeId !== null && to > from) to -= 1;
    const plan = planReorder(section.tasks, from, to);
    const results = await Promise.allSettled(plan.map((p) => api.update(p.id, { order: p.order })));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) fail('reorder', (failed[0] as PromiseRejectedResult).reason);
  };

  const moveBy = (t: TaskSummary, delta: -1 | 1): void => {
    const section = groups.find((g) => g.tasks.some((x) => x.id === t.id));
    if (!section) return;
    const from = section.tasks.findIndex((x) => x.id === t.id);
    const to = from + delta;
    if (to < 0 || to >= section.tasks.length) return;
    const plan = planReorder(section.tasks, from, to);
    void Promise.allSettled(plan.map((p) => api.update(p.id, { order: p.order }))).then(
      (results) => {
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length) fail('reorder', (failed[0] as PromiseRejectedResult).reason);
      }
    );
  };

  const draggedIds = (e: React.DragEvent): string[] => {
    try {
      const ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || '[]');
      return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };

  const onRowDragStart = (t: TaskSummary, e: React.DragEvent): void => {
    // Dragging a picked task carries every picked task.
    const ids = picked.has(t.id) ? [...picked] : [t.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };

  const manual = sort === 'manual';

  /** Focus a field in the open detail panel (opening it on the selected task first). */
  const focusDetail = (selector: string): void => {
    if (!selectedId) return;
    requestAnimationFrame(() => {
      const el = detailRef.current?.querySelector<HTMLInputElement>(selector);
      el?.focus();
      el?.select?.();
    });
  };

  const setView = (v: ViewId): void => {
    setPrefs((p) => ({ ...p, view: v }));
    setQuery('');
    setSelectedId(null);
    setPicked(new Set());
    setDay(null);
    setNaming(null);
  };

  const setGroup = (g: TaskGroup): void => {
    if (saved) void updateSaved({ ...saved, group: g });
    else setPrefs((p) => ({ ...p, group: g }));
  };
  const setSort = (s: TaskSort): void => {
    if (saved) void updateSaved({ ...saved, sort: s });
    else setPrefs((p) => ({ ...p, sort: s }));
  };

  const persistViews = async (next: SavedTaskView[]): Promise<boolean> => {
    try {
      setSavedViews(await api.saveSavedViews(next));
      return true;
    } catch (err) {
      fail('save the views', err);
      return false;
    }
  };
  const updateSaved = (v: SavedTaskView): Promise<boolean> =>
    persistViews(savedViews.map((x) => (x.id === v.id ? v : x)));

  const saveCurrentView = async (name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Scope the saved search to the project or tag being viewed.
    const prefix =
      scope.kind === 'project'
        ? `+"${scope.name}" `
        : scope.kind === 'tag'
          ? `#${scope.name} `
          : saved
            ? `${saved.query} `
            : '';
    const v: SavedTaskView = {
      id: Math.random().toString(36).slice(2, 10),
      name: trimmed,
      query: `${prefix}${query}`.trim(),
      group,
      sort
    };
    if (await persistViews([...savedViews, v])) setView(`saved:${v.id}`);
  };

  const deleteSaved = async (v: SavedTaskView): Promise<void> => {
    if (!window.confirm(`Delete the saved view "${v.name}"? Its tasks aren't affected.`)) return;
    if ((await persistViews(savedViews.filter((x) => x.id !== v.id))) && view === `saved:${v.id}`)
      setView('today');
  };

  const onListKey = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('.cm-editor')) return;
    if (target.closest('.task-detail')) return; // the panel has its own keys
    const key = e.key;
    const index = ordered.findIndex((t) => t.id === selectedId);
    const current = index >= 0 ? ordered[index] : undefined;
    if (e.altKey && !e.metaKey && !e.ctrlKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      if (current && manual) {
        e.preventDefault();
        moveBy(current, key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (pendingG.current) {
      pendingG.current = false;
      const v = VIEW_KEYS[key.toLowerCase()];
      if (v) {
        e.preventDefault();
        setView(v);
      }
      return;
    }
    switch (key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        if (ordered.length) select(ordered[Math.min(index + 1, ordered.length - 1)].id);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        if (ordered.length) select(ordered[Math.max(index - 1, 0)].id);
        break;
      case ' ':
        if (pickedTasks.length) {
          e.preventDefault();
          void completeAll(pickedTasks);
        } else if (current) {
          e.preventDefault();
          void toggle(current);
        }
        break;
      case 'x':
        if (current) {
          e.preventDefault();
          togglePick(current.id);
        }
        break;
      case 'Enter':
        if (current) {
          e.preventDefault();
          detailRef.current?.querySelector<HTMLElement>('.task-detail')?.focus();
        }
        break;
      case 'e':
        e.preventDefault();
        focusDetail('.task-detail-title');
        break;
      case 'd':
      case 's':
      case 'r':
      case 't': {
        // (j is taken by "move down" above; project is reached from the panel.)
        const field = { d: 0, s: 1, r: 2, t: 4 }[key as 'd' | 's' | 'r' | 't'];
        if (field !== undefined) {
          e.preventDefault();
          requestAnimationFrame(() => {
            const inputs = detailRef.current?.querySelectorAll<HTMLInputElement>(
              '.task-detail-field input'
            );
            inputs?.[field]?.focus();
            inputs?.[field]?.select();
          });
        }
        break;
      }
      case 'n':
        e.preventDefault();
        openCapture();
        break;
      case '/':
        e.preventDefault();
        searchRef.current?.focus();
        break;
      case 'g':
        pendingG.current = true;
        window.setTimeout(() => (pendingG.current = false), 1200);
        break;
      case '?':
        e.preventDefault();
        setShowHelp((s) => !s);
        break;
      case 'Escape':
        if (showHelp) setShowHelp(false);
        else if (picked.size) setPicked(new Set());
        else if (selectedId) setSelectedId(null);
        else if (day) setDay(null);
        else if (query) setQuery('');
        break;
    }
  };

  // Defaults from the view a task is added in.
  const addInView = async (input: NewTaskInput): Promise<void> => {
    const next = { ...input };
    if (showStrip && day && day !== 'overdue' && !next.due) next.due = day;
    else if (builtin === 'today' && !next.due) next.due = today;
    if (scope.kind === 'project' && !next.project) next.project = scope.name;
    if (
      scope.kind === 'tag' &&
      !next.tags?.some((t) => t.toLowerCase() === scope.name.toLowerCase())
    )
      next.tags = [...(next.tags ?? []), scope.name];
    const created = await api.create(next);
    setCapturing(false);
    setSelectedId(created.id);
    listRef.current?.focus();
  };

  const viewLabel =
    scope.kind === 'checklist'
      ? 'Checklist items'
      : scope.kind === 'problems'
        ? 'Problems'
        : scope.kind === 'project'
          ? scope.name
          : scope.kind === 'tag'
            ? `#${scope.name}`
            : scope.kind === 'saved'
              ? (saved?.name ?? 'Saved view')
              : TASK_VIEWS.find((v) => v.id === scope.id)?.label;

  const heading =
    showStrip && day
      ? day === 'overdue'
        ? 'Overdue'
        : friendlyDueLabel(day, today).text
      : searching && scope.kind === 'builtin'
        ? 'Search'
        : viewLabel;

  const captureHeading =
    showStrip && day && day !== 'overdue'
      ? `New task (due ${friendlyDueLabel(day, today).text} unless you say otherwise)`
      : builtin === 'today'
        ? 'New task (due today unless you say otherwise)'
        : scope.kind === 'project'
          ? `New task in ${scope.name}`
          : scope.kind === 'tag'
            ? `New task tagged #${scope.name}`
            : 'New task';

  const canSave =
    searching && naming === null && scope.kind !== 'checklist' && scope.kind !== 'problems';

  const navButton = (
    id: ViewId,
    icon: string,
    label: string,
    count?: number,
    extra?: React.ReactNode
  ): React.JSX.Element => (
    <div key={id} className="task-manager-view-item">
      <button
        type="button"
        className={view === id && !(searching && scope.kind === 'builtin') ? 'active' : ''}
        onClick={() => setView(id)}
        title={label}
      >
        <span className="material-symbols-outlined">{icon}</span>
        <span className="task-manager-view-label">{label}</span>
        {count !== undefined && count > 0 && (
          <span className="task-manager-view-count">{count}</span>
        )}
      </button>
      {extra}
    </div>
  );

  return (
    <div className="task-manager" onKeyDown={onListKey}>
      <nav className="task-manager-views" aria-label="Task views">
        {TASK_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={view === v.id && !searching ? 'active' : ''}
            onClick={() => setView(v.id)}
            title={v.hint}
          >
            <span className="material-symbols-outlined">{v.icon}</span>
            <span className="task-manager-view-label">{v.label}</span>
            {v.id !== 'all' && v.id !== 'logbook' && counts[v.id] > 0 && (
              <span className="task-manager-view-count">{counts[v.id]}</span>
            )}
          </button>
        ))}

        {savedViews.length > 0 && (
          <>
            <h4 className="task-manager-views-heading">Saved</h4>
            {savedViews.map((v) =>
              navButton(
                `saved:${v.id}`,
                'bookmark',
                v.name,
                undefined,
                <button
                  type="button"
                  className="task-manager-view-remove material-symbols-outlined"
                  title={`Delete the saved view "${v.name}"`}
                  aria-label={`Delete the saved view ${v.name}`}
                  onClick={() => void deleteSaved(v)}
                >
                  close
                </button>
              )
            )}
          </>
        )}

        {projects.length > 0 && (
          <>
            <h4 className="task-manager-views-heading">Projects</h4>
            {projects.map((p) => navButton(`project:${p.name}`, 'folder', p.name, p.count))}
          </>
        )}

        {tags.length > 0 && (
          <>
            <h4 className="task-manager-views-heading">Tags</h4>
            {tags.map((t) => navButton(`tag:${t.name}`, 'sell', `#${t.name}`, t.count))}
          </>
        )}

        <div className="task-manager-views-divider" />
        <button
          type="button"
          className={view === 'checklist' ? 'active' : ''}
          onClick={() => setView('checklist')}
          title="Checkbox tasks written in notes ( - [ ] ), until they're converted"
        >
          <span className="material-symbols-outlined">checklist</span>
          <span className="task-manager-view-label">Checklist items</span>
          {checklistCount > 0 && <span className="task-manager-view-count">{checklistCount}</span>}
        </button>
        {problems.length > 0 && (
          <button
            type="button"
            className={`problems ${view === 'problems' ? 'active' : ''}`}
            onClick={() => setView('problems')}
          >
            <span className="material-symbols-outlined">error</span>
            <span className="task-manager-view-label">Problems</span>
            <span className="task-manager-view-count">{problems.length}</span>
          </button>
        )}
      </nav>

      {scope.kind === 'checklist' ? (
        <div className="task-manager-legacy">
          {convertibleCount > 0 && (
            <div className="task-manager-convert-banner">
              <span className="material-symbols-outlined">add_task</span>
              <span>
                {convertibleCount} checkbox task{convertibleCount === 1 ? ' has' : 's have'} a date,
                repeat or priority. Convert them to task files to manage them here.
              </span>
              <button type="button" onClick={onConvert}>
                Preview &amp; convert…
              </button>
            </div>
          )}
          {checklistView}
        </div>
      ) : (
        <>
          <div
            className="task-manager-list"
            ref={listRef}
            tabIndex={0}
            role="listbox"
            aria-label={viewLabel}
            aria-multiselectable
          >
            <div className="task-manager-toolbar">
              <h2>{heading}</h2>
              <button
                type="button"
                ref={addRef}
                className="task-manager-add"
                onClick={() => openCapture()}
              >
                <span className="material-symbols-outlined">add</span>
                New task <kbd>N</kbd>
              </button>
            </div>

            {showStrip && (
              <div className="task-manager-strip" role="group" aria-label="Next two weeks">
                {dueCounts.overdue > 0 && (
                  <button
                    type="button"
                    className={`task-manager-strip-day overdue ${day === 'overdue' ? 'active' : ''}`}
                    onClick={() => setDay((d) => (d === 'overdue' ? null : 'overdue'))}
                    title="Overdue"
                  >
                    <span className="task-manager-strip-weekday">Late</span>
                    <span className="material-symbols-outlined">warning</span>
                    <span className="task-manager-strip-count">{dueCounts.overdue}</span>
                  </button>
                )}
                {stripDays.map((d) => {
                  const { weekday, date } = shortDay(d);
                  const n = dueCounts.byDay.get(d) ?? 0;
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`task-manager-strip-day ${d === today ? 'today' : ''} ${day === d ? 'active' : ''} ${dragOverDay === d ? 'drop' : ''}`}
                      title={`${friendlyDueLabel(d, today).text} - drop tasks here to reschedule`}
                      onClick={() => setDay((cur) => (cur === d ? null : d))}
                      onDragOver={(e) => {
                        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                        e.preventDefault();
                        setDragOverDay(d);
                      }}
                      onDragLeave={() => setDragOverDay((cur) => (cur === d ? null : cur))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverDay(null);
                        const list = draggedIds(e)
                          .map((id) => byId.get(id))
                          .filter((t): t is TaskSummary => Boolean(t));
                        void applyAll(list, (t) => ({ due: rescheduled(t, d) }));
                      }}
                    >
                      <span className="task-manager-strip-weekday">{weekday}</span>
                      <span className="task-manager-strip-date">{date}</span>
                      <span className="task-manager-strip-count">{n > 0 ? n : ''}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="task-manager-search">
              <span className="material-symbols-outlined">search</span>
              <input
                ref={searchRef}
                value={query}
                placeholder={
                  scope.kind === 'builtin'
                    ? 'Search, or filter: due:<7d #bills +Home status:waiting'
                    : `Search in ${viewLabel}`
                }
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (
                    !parseTaskFilter(saved ? `${saved.query} ${e.target.value}` : e.target.value)
                      .text
                  )
                    setSearchIds(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setQuery('');
                    listRef.current?.focus();
                  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                    e.preventDefault();
                    if (ordered[0]) select(ordered[0].id);
                    listRef.current?.focus();
                  }
                }}
              />
              {filter.terms.map((t) => (
                <span key={t} className="task-manager-term">
                  {t}
                </span>
              ))}
              {canSave && (
                <button
                  type="button"
                  className="task-manager-save-view"
                  onClick={() => setNaming('')}
                  title="Save this search as a view"
                >
                  <span className="material-symbols-outlined">bookmark_add</span>
                  Save
                </button>
              )}
            </div>
            {naming !== null && (
              <form
                className="task-manager-name-view"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveCurrentView(naming);
                }}
              >
                <input
                  autoFocus
                  value={naming}
                  placeholder="Name this view"
                  aria-label="Saved view name"
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setNaming(null);
                    }
                  }}
                />
                <button type="submit" disabled={!naming.trim()}>
                  Save view
                </button>
                <button type="button" onClick={() => setNaming(null)}>
                  Cancel
                </button>
              </form>
            )}
            {saved && (
              <p className="task-manager-saved-query">
                <span className="material-symbols-outlined">bookmark</span>
                <code>{saved.query || '(every task)'}</code>
              </p>
            )}

            {scope.kind !== 'problems' && (
              <div className="task-manager-controls">
                <label>
                  Group
                  <select value={group} onChange={(e) => setGroup(e.target.value as TaskGroup)}>
                    <option value="due">Due date</option>
                    <option value="project">Project</option>
                    <option value="priority">Priority</option>
                    <option value="status">Status</option>
                    <option value="tag">Tag</option>
                    <option value="none">None</option>
                  </select>
                </label>
                <label>
                  Sort
                  <select value={sort} onChange={(e) => setSort(e.target.value as TaskSort)}>
                    <option value="due">Due date</option>
                    <option value="manual">Manual</option>
                    <option value="priority">Priority</option>
                    <option value="created">Newest</option>
                    <option value="updated">Recently changed</option>
                    <option value="title">Title</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="task-manager-help"
                  onClick={() => setShowHelp((s) => !s)}
                >
                  <kbd>?</kbd> Shortcuts
                </button>
              </div>
            )}

            {error && (
              <div className="task-manager-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            )}

            {pickedTasks.length > 0 && (
              <BulkBar
                count={pickedTasks.length}
                onApply={(patchFor) => void applyAll(pickedTasks, patchFor)}
                onComplete={() => void completeAll(pickedTasks)}
                onDelete={() => void deleteAll(pickedTasks)}
                onClear={() => {
                  setPicked(new Set());
                  listRef.current?.focus();
                }}
              />
            )}

            {scope.kind === 'problems' ? (
              <ul className="task-manager-problems">
                {problems.map((p) => (
                  <li key={p.path}>
                    <strong>{p.path}</strong>
                    <span>{p.error}</span>
                  </li>
                ))}
              </ul>
            ) : !ready ? (
              <p className="task-manager-empty">Loading tasks…</p>
            ) : ordered.length === 0 ? (
              <p className="task-manager-empty">
                {searching
                  ? 'Nothing matches.'
                  : day
                    ? 'Nothing due then.'
                    : builtin === 'inbox'
                      ? 'Inbox zero.'
                      : builtin === 'today'
                        ? 'Nothing due today.'
                        : 'Nothing here.'}
              </p>
            ) : (
              groups.map((g) => (
                <section
                  key={g.key}
                  className="task-manager-group"
                  onDragOver={(e) => {
                    // Dropping below the last row moves to the end of the group.
                    if (!manual || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    if (
                      e.target === e.currentTarget ||
                      (e.target as HTMLElement).tagName === 'UL'
                    ) {
                      e.preventDefault();
                      setDropBefore(`end:${g.key}`);
                    }
                  }}
                  onDrop={(e) => {
                    if (dropBefore !== `end:${g.key}`) return;
                    e.preventDefault();
                    setDropBefore(null);
                    const [id] = draggedIds(e);
                    if (id) void moveTask(id, null);
                  }}
                >
                  {g.label && (
                    <h3>
                      {g.label} <span>{g.tasks.length}</span>
                    </h3>
                  )}
                  <ul className={dropBefore === `end:${g.key}` ? 'drop-end' : ''}>
                    {g.tasks.map((t) => (
                      <TaskRow
                        key={`${g.key}:${t.id}`}
                        task={t}
                        today={today}
                        selected={t.id === selectedId}
                        picked={picked.has(t.id)}
                        dropTarget={manual && dropBefore === t.id}
                        onSelect={(e) => onRowClick(t, e)}
                        onToggle={() => void toggle(t)}
                        onDragStart={(e) => onRowDragStart(t, e)}
                        onDragOver={
                          manual
                            ? (e) => {
                                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setDropBefore(t.id);
                              }
                            : undefined
                        }
                        onDrop={
                          manual
                            ? (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setDropBefore(null);
                                const [id] = draggedIds(e);
                                if (id && id !== t.id) void moveTask(id, t.id);
                              }
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>

          <aside className="task-manager-detail" ref={detailRef}>
            {selectedId ? (
              <TaskDetail
                key={selectedId}
                id={selectedId}
                variant="panel"
                onClose={() => {
                  setSelectedId(null);
                  listRef.current?.focus();
                }}
                onNavigate={onNavigate}
              />
            ) : (
              <div className="task-manager-detail-empty">
                <span className="material-symbols-outlined">task_alt</span>
                <p>Select a task to see its details.</p>
                <p className="task-manager-detail-hint">
                  ⌘-click or ⇧-click to pick several and change them together.
                </p>
              </div>
            )}
          </aside>
        </>
      )}

      {capturing !== false && (
        <TaskCapture
          anchorRect={capturing}
          heading={captureHeading}
          onSubmit={addInView}
          onCancel={() => {
            setCapturing(false);
            listRef.current?.focus();
          }}
        />
      )}

      {showHelp && (
        <div className="task-manager-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
          <h3>Keyboard shortcuts</h3>
          <dl>
            {SHORTCUTS.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <button type="button" onClick={() => setShowHelp(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

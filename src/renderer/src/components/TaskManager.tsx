/**
 * The Tasks tab: task files (`_tasks/`) as a task manager.
 *
 *   views | list (search, group, sort, quick add) | detail panel
 *
 * Views: Inbox, Today, Upcoming, Anytime, Waiting, Scheduled, Logbook, All -
 * plus "Checklist items" (inline `- [ ]` tasks in notes, until they're
 * converted) and Problems (task files that couldn't be read).
 *
 * Search takes free text (full-text across title, notes, checklist,
 * comments) and filters like `due:<7d #bills +Home status:waiting` (see
 * shared/taskQuery.ts).
 *
 * Keyboard (list focused): J/K or arrows move; Space completes or reopens;
 * Enter opens the detail panel; E edits the title; D/S/R/T edit due, start,
 * repeat, tags (J for project, from the panel); N adds; / searches; G then I/T/U/A/W/S/L jumps to a
 * view; ? lists the shortcuts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskSummary } from '../../../shared/taskViews';
import {
  TASK_VIEWS,
  groupTasks,
  inView,
  parseTaskFilter,
  sortTasks,
  viewCounts,
  type TaskGroup,
  type TaskSort,
  type TaskViewId
} from '../../../shared/taskQuery';
import { localDate } from '../../../shared/taskRecord';
import { describeRepeat } from '../../../shared/taskRepeat';
import type { NewTaskInput } from '../../../shared/taskOps';
import { useTaskRecords } from '../tasks/taskRecordsStore';
import { friendlyDueLabel, PRIORITY_ICON, PRIORITY_LABEL } from '../utils/taskDisplay';
import { TaskDetail } from './TaskDetail';
import { TaskCapture } from './TaskCapture';
import '../styles/TaskManager.css';

type ViewId = TaskViewId | 'checklist' | 'problems';

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
  ['Space', 'Complete or reopen'],
  ['Enter', 'Open the task'],
  ['E', 'Edit the title'],
  ['D / S / R / T', 'Edit due, start, repeat, tags'],
  ['Enter, then J', 'Edit the project (in the task panel)'],
  ['N', 'New task'],
  ['/', 'Search'],
  ['G then I T U A W S L', 'Go to Inbox, Today, Upcoming, Anytime, Waiting, Scheduled, Logbook'],
  ['Esc', 'Close the task, clear the search'],
  ['?', 'Show these shortcuts']
];

function TaskRow({
  task,
  selected,
  today,
  onSelect,
  onToggle
}: {
  task: TaskSummary;
  selected: boolean;
  today: string;
  onSelect: () => void;
  onToggle: () => void;
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
      className={`task-row status-${task.status} ${selected ? 'selected' : ''}`}
      data-task-id={task.id}
      onClick={onSelect}
      aria-selected={selected}
      role="option"
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
  // Open quick-add: where to anchor it (null = centered), or false when closed.
  const [capturing, setCapturing] = useState<DOMRect | null | false>(false);
  const openCapture = (): void => setCapturing(addRef.current?.getBoundingClientRect() ?? null);
  const [showHelp, setShowHelp] = useState(false);
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

  const filter = useMemo(() => parseTaskFilter(query), [query]);

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
  const view = prefs.view;
  const counts = useMemo(() => viewCounts(tasks, today), [tasks, today]);

  const visible = useMemo(() => {
    if (view === 'checklist' || view === 'problems') return [];
    // A search looks across every task, not just the current view.
    const pool = searching ? tasks : tasks.filter((t) => inView(t, view, today));
    const matched = pool.filter(
      (t) => filter.test(t, { today }) && (!filter.text || (searchIds?.has(t.id) ?? false))
    );
    return sortTasks(matched, prefs.sort, searching ? undefined : view);
  }, [tasks, view, searching, filter, searchIds, prefs.sort, today]);

  const groups = useMemo(
    () => groupTasks(visible, prefs.group, today, searching ? undefined : (view as TaskViewId)),
    [visible, prefs.group, today, searching, view]
  );
  const ordered = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);

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

  const toggle = async (t: TaskSummary): Promise<void> => {
    try {
      if (t.status === 'done' || t.status === 'cancelled')
        await api.update(t.id, { status: 'todo' });
      else await api.complete(t.id);
    } catch (err) {
      console.error('[Tasks] toggle failed', err);
    }
  };

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
  };

  const onListKey = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('.cm-editor')) return;
    if (target.closest('.task-detail')) return; // the panel has its own keys
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (pendingG.current) {
      pendingG.current = false;
      const v = VIEW_KEYS[key.toLowerCase()];
      if (v) {
        e.preventDefault();
        setView(v);
      }
      return;
    }
    const index = ordered.findIndex((t) => t.id === selectedId);
    const current = index >= 0 ? ordered[index] : undefined;
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
        if (current) {
          e.preventDefault();
          void toggle(current);
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
        else if (selectedId) setSelectedId(null);
        else if (query) setQuery('');
        break;
    }
  };

  // Defaults from the view a task is added in.
  const addInView = async (input: NewTaskInput): Promise<void> => {
    const next = { ...input };
    if (view === 'today' && !next.due) next.due = today;
    const created = await api.create(next);
    setCapturing(false);
    setSelectedId(created.id);
    listRef.current?.focus();
  };

  const viewLabel =
    view === 'checklist'
      ? 'Checklist items'
      : view === 'problems'
        ? 'Problems'
        : TASK_VIEWS.find((v) => v.id === view)?.label;

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

      {view === 'checklist' ? (
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
          >
            <div className="task-manager-toolbar">
              <h2>{searching ? 'Search' : viewLabel}</h2>
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
            <div className="task-manager-search">
              <span className="material-symbols-outlined">search</span>
              <input
                ref={searchRef}
                value={query}
                placeholder="Search, or filter: due:<7d #bills +Home status:waiting"
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!parseTaskFilter(e.target.value).text) setSearchIds(null);
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
            </div>
            {view !== 'problems' && (
              <div className="task-manager-controls">
                <label>
                  Group
                  <select
                    value={prefs.group}
                    onChange={(e) =>
                      setPrefs((p) => ({ ...p, group: e.target.value as TaskGroup }))
                    }
                  >
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
                  <select
                    value={prefs.sort}
                    onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as TaskSort }))}
                  >
                    <option value="due">Due date</option>
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

            {view === 'problems' ? (
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
                  : view === 'inbox'
                    ? 'Inbox zero.'
                    : view === 'today'
                      ? 'Nothing due today.'
                      : 'Nothing here.'}
              </p>
            ) : (
              groups.map((g) => (
                <section key={g.key} className="task-manager-group">
                  {g.label && (
                    <h3>
                      {g.label} <span>{g.tasks.length}</span>
                    </h3>
                  )}
                  <ul>
                    {g.tasks.map((t) => (
                      <TaskRow
                        key={`${g.key}:${t.id}`}
                        task={t}
                        today={today}
                        selected={t.id === selectedId}
                        onSelect={() => select(t.id)}
                        onToggle={() => void toggle(t)}
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
              </div>
            )}
          </aside>
        </>
      )}

      {capturing !== false && (
        <TaskCapture
          anchorRect={capturing}
          heading={view === 'today' ? 'New task (due today unless you say otherwise)' : 'New task'}
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

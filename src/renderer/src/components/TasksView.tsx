import React, { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../../types/phosphor';
import { todayString, isPastDate, isTodayDate, formatTimestamp, type Priority } from '../../../shared/tasks';
import { PRIORITY_ICON, PRIORITY_LABEL, dueDateLabel, recurrenceLabel } from '../utils/taskDisplay';
import { TaskMetadataPopover, type TaskMetadataValue } from './TaskMetadataPopover';
import '../styles/EditorTaskWidgets.css';
import '../styles/TasksView.css';

type GroupMode = 'smart' | 'file' | 'priority';
type StatusFilter = 'all' | 'todo' | 'doing' | 'done';
type PriorityFilterValue = 'high' | 'medium' | 'low' | 'none';
type SmartBucket = 'overdue' | 'today' | 'upcoming' | 'later' | 'no-date';

interface TasksViewProps {
  tasks: Task[];
  /** True once the vault's task index has resolved at least once (cache or live) - distinguishes "still loading" from "genuinely empty." */
  tasksLoaded: boolean;
  onTaskClick: (filename: string, line: number) => void;
  onToggleStatus: (task: Task) => void;
  onUpdateMetadata: (task: Task, value: TaskMetadataValue) => void;
  onQuickAdd: (text: string) => void;
  onNavigateToDate?: (dateStr: string) => void;
}

function daysFromTodayLocal(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const PRIORITY_WEIGHT: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
function priorityWeight(p?: Priority): number {
  return p ? PRIORITY_WEIGHT[p] : 3;
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pw = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (pw !== 0) return pw;
    if (a.dueDate && b.dueDate) {
      const dc = a.dueDate.localeCompare(b.dueDate);
      if (dc !== 0) return dc;
    } else if (a.dueDate && !b.dueDate) {
      return -1;
    } else if (!a.dueDate && b.dueDate) {
      return 1;
    }
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
}

function smartBucket(task: Task, today: string, weekOut: string): SmartBucket {
  if (!task.dueDate) return 'no-date';
  if (isPastDate(task.dueDate, today)) return 'overdue';
  if (isTodayDate(task.dueDate, today)) return 'today';
  if (task.dueDate <= weekOut) return 'upcoming';
  return 'later';
}

const SMART_GROUP_ORDER: { key: SmartBucket; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming (7 days)' },
  { key: 'later', label: 'Later' },
  { key: 'no-date', label: 'No date' }
];

const PRIORITY_FILTER_LEVELS: PriorityFilterValue[] = ['high', 'medium', 'low', 'none'];

interface TaskGroup {
  key: string;
  label: string;
  items: Task[];
}

function TaskRow({
  task,
  onNavigate,
  onToggleStatus,
  onOpenMetadata
}: {
  task: Task;
  onNavigate: () => void;
  onToggleStatus: () => void;
  onOpenMetadata: (rect: DOMRect) => void;
}): React.JSX.Element {
  const statusIcon =
    task.status === 'todo'
      ? 'check_box_outline_blank'
      : task.status === 'doing'
        ? 'indeterminate_check_box'
        : 'check_box';

  const hasMetadata = Boolean(task.priority || task.dueDate || task.recurrence);

  return (
    <div className={`task-item task-${task.status}`} onClick={onNavigate}>
      <span
        className="task-status-icon"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStatus();
        }}
        title="Cycle status"
      >
        <span className="material-symbols-outlined">{statusIcon}</span>
      </span>
      <span className="task-text">{task.text}</span>
      <div className="task-pills" onClick={(e) => e.stopPropagation()}>
        {task.priority && (
          <span
            className={`cm-task-pill cm-task-pill-priority-${task.priority}`}
            onClick={(e) => onOpenMetadata((e.currentTarget as HTMLElement).getBoundingClientRect())}
            title={PRIORITY_LABEL[task.priority]}
          >
            <span className="material-symbols-outlined cm-task-pill-icon">
              {PRIORITY_ICON[task.priority]}
            </span>
          </span>
        )}
        {task.dueDate &&
          (() => {
            const { text, status } = dueDateLabel(task.dueDate);
            return (
              <span
                className={`cm-task-pill cm-task-pill-date-${status}`}
                onClick={(e) => onOpenMetadata((e.currentTarget as HTMLElement).getBoundingClientRect())}
              >
                <span className="material-symbols-outlined cm-task-pill-icon">calendar_today</span>
                <span className="cm-task-pill-label">{text}</span>
              </span>
            );
          })()}
        {task.recurrence && (
          <span
            className={`cm-task-pill cm-task-pill-recurrence ${task.recurrence.supported ? '' : 'cm-task-pill-unsupported'}`}
            onClick={(e) => onOpenMetadata((e.currentTarget as HTMLElement).getBoundingClientRect())}
          >
            <span className="material-symbols-outlined cm-task-pill-icon">repeat</span>
            <span className="cm-task-pill-label">
              {recurrenceLabel(task.recurrence.amount, task.recurrence.unit, task.recurrence.supported)}
            </span>
          </span>
        )}
        {!hasMetadata && (
          <button
            type="button"
            className="cm-task-add-metadata"
            onClick={(e) => onOpenMetadata((e.currentTarget as HTMLElement).getBoundingClientRect())}
            title="Add due date, recurrence, or priority"
          >
            <span className="material-symbols-outlined">add_circle</span>
          </button>
        )}
      </div>
      {task.status === 'done' && task.completedAt && (
        <span className="task-completed-time">Completed {formatTimestamp(task.completedAt)}</span>
      )}
      <span className="task-line">L{task.line}</span>
    </div>
  );
}

export const TasksView: React.FC<TasksViewProps> = ({
  tasks,
  tasksLoaded,
  onTaskClick,
  onToggleStatus,
  onUpdateMetadata,
  onQuickAdd,
  onNavigateToDate
}) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilterValue[]>([]);
  const [groupMode, setGroupMode] = useState<GroupMode>('smart');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    done: true,
    later: true,
    'no-date': true
  });
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  const [quickAddText, setQuickAddText] = useState('');
  const [popover, setPopover] = useState<{ task: Task; anchorRect: DOMRect } | null>(null);

  // Load saved filter/group preferences on mount.
  useEffect(() => {
    let mounted = true;
    const load = async (): Promise<void> => {
      try {
        const settings = await window.phosphor.getSettings();
        if (!mounted) return;
        if (settings.lastTasksStatusFilter) setStatusFilter(settings.lastTasksStatusFilter);
        if (settings.lastTasksGroupMode) setGroupMode(settings.lastTasksGroupMode);
        if (settings.lastTasksPriorityFilter) setPriorityFilter(settings.lastTasksPriorityFilter);
      } catch (err) {
        console.error('Failed to load TasksView settings:', err);
      } finally {
        if (mounted) setFiltersLoaded(true);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  // Persist filter/group preferences (not search text) once loaded.
  useEffect(() => {
    if (!filtersLoaded) return;
    window.phosphor
      .setMultipleSettings({
        lastTasksStatusFilter: statusFilter,
        lastTasksGroupMode: groupMode,
        lastTasksPriorityFilter: priorityFilter
      })
      .catch((err) => console.error('Failed to save TasksView settings:', err));
  }, [statusFilter, groupMode, priorityFilter, filtersLoaded]);

  const today = todayString();
  const weekOut = daysFromTodayLocal(7);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (overdueOnly && !(t.dueDate && t.status !== 'done' && isPastDate(t.dueDate, today))) {
        return false;
      }
      if (priorityFilter.length > 0) {
        const key: PriorityFilterValue = t.priority ?? 'none';
        if (!priorityFilter.includes(key)) return false;
      }
      if (q && !t.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tasks, statusFilter, overdueOnly, priorityFilter, search, today]);

  const counts = useMemo(() => {
    const c = { todo: 0, doing: 0, done: 0, overdue: 0, high: 0, medium: 0, low: 0, none: 0 };
    for (const t of tasks) {
      c[t.status] += 1;
      if (t.dueDate && t.status !== 'done' && isPastDate(t.dueDate, today)) c.overdue += 1;
      c[t.priority ?? 'none'] += 1;
    }
    return c;
  }, [tasks, today]);

  const groups = useMemo((): TaskGroup[] => {
    if (groupMode === 'file') {
      const byFile = new Map<string, Task[]>();
      for (const t of filtered) {
        if (!byFile.has(t.file)) byFile.set(t.file, []);
        byFile.get(t.file)!.push(t);
      }
      return Array.from(byFile.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, items]) => ({ key, label: key, items: sortTasks(items) }));
    }

    if (groupMode === 'priority') {
      const levels: { key: PriorityFilterValue; label: string }[] = [
        { key: 'high', label: 'High priority' },
        { key: 'medium', label: 'Medium priority' },
        { key: 'low', label: 'Low priority' },
        { key: 'none', label: 'No priority' }
      ];
      return levels
        .map(({ key, label }) => ({
          key,
          label,
          items: sortTasks(filtered.filter((t) => (t.priority ?? 'none') === key))
        }))
        .filter((g) => g.items.length > 0);
    }

    // 'smart' (default): urgency buckets, with Done as a separate trailing section.
    const done = sortTasks(filtered.filter((t) => t.status === 'done')).sort((a, b) =>
      (b.completedAt ?? '').localeCompare(a.completedAt ?? '')
    );
    const open = filtered.filter((t) => t.status !== 'done');
    const buckets = new Map<SmartBucket, Task[]>();
    for (const t of open) {
      const bucket = smartBucket(t, today, weekOut);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(t);
    }
    const result: TaskGroup[] = SMART_GROUP_ORDER.filter(
      (g) => (buckets.get(g.key)?.length ?? 0) > 0
    ).map((g) => ({ key: g.key, label: g.label, items: sortTasks(buckets.get(g.key) ?? []) }));
    if (done.length > 0) result.push({ key: 'done', label: 'Done', items: done });
    return result;
  }, [filtered, groupMode, today, weekOut]);

  const toggleCollapsed = (key: string): void => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const popoverInitial: TaskMetadataValue = popover
    ? {
        due: popover.task.dueDate,
        recurrence: popover.task.recurrence?.supported
          ? { amount: popover.task.recurrence.amount, unit: popover.task.recurrence.unit }
          : undefined,
        priority: popover.task.priority
      }
    : {};

  if (!tasksLoaded) {
    return <div className="tasks-view loading">Loading tasks...</div>;
  }

  return (
    <div className="tasks-view">
      <div className="tasks-header">
        <h2>Tasks</h2>
        <div className="tasks-group-toggle">
          {(
            [
              { mode: 'smart', label: 'Due' },
              { mode: 'file', label: 'By File' },
              { mode: 'priority', label: 'By Priority' }
            ] as { mode: GroupMode; label: string }[]
          ).map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className={`group-mode-btn ${groupMode === mode ? 'active' : ''}`}
              onClick={() => setGroupMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="tasks-toolbar">
        <input
          type="text"
          className="tasks-search-input"
          placeholder="Search tasks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tasks-filter-row">
          <div className="filter-group">
            <button
              className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              All ({tasks.length})
            </button>
            <button
              className={`filter-btn ${statusFilter === 'todo' ? 'active' : ''}`}
              onClick={() => setStatusFilter('todo')}
            >
              Todo ({counts.todo})
            </button>
            <button
              className={`filter-btn ${statusFilter === 'doing' ? 'active' : ''}`}
              onClick={() => setStatusFilter('doing')}
            >
              Doing ({counts.doing})
            </button>
            <button
              className={`filter-btn ${statusFilter === 'done' ? 'active' : ''}`}
              onClick={() => setStatusFilter('done')}
            >
              Done ({counts.done})
            </button>
          </div>
          <button
            className={`filter-btn overdue-toggle ${overdueOnly ? 'active' : ''}`}
            onClick={() => setOverdueOnly((v) => !v)}
          >
            🔴 Overdue only ({counts.overdue})
          </button>
          <div className="filter-group priority-filter-group">
            {PRIORITY_FILTER_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className={`priority-chip priority-chip-${level} ${priorityFilter.includes(level) ? 'active' : ''}`}
                title={level === 'none' ? 'No priority' : PRIORITY_LABEL[level]}
                onClick={() =>
                  setPriorityFilter((prev) =>
                    prev.includes(level) ? prev.filter((p) => p !== level) : [...prev, level]
                  )
                }
              >
                {level === 'none' ? (
                  <span>—</span>
                ) : (
                  <span className="material-symbols-outlined">{PRIORITY_ICON[level]}</span>
                )}
                <span className="priority-chip-count">{counts[level]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <form
        className="tasks-quick-add"
        onSubmit={(e) => {
          e.preventDefault();
          const text = quickAddText.trim();
          if (!text) return;
          onQuickAdd(text);
          setQuickAddText('');
        }}
      >
        <span className="material-symbols-outlined">add_task</span>
        <input
          type="text"
          placeholder="Add a task to today's journal..."
          value={quickAddText}
          onChange={(e) => setQuickAddText(e.target.value)}
        />
      </form>

      <div className="tasks-list">
        {groups.length === 0 ? (
          <div className="empty-state">
            {tasks.length === 0 ? (
              <>
                <p>📋 No tasks in this vault yet</p>
                <p style={{ fontSize: '14px', opacity: 0.6 }}>
                  Add tasks using GFM syntax: - [ ] Task text
                </p>
              </>
            ) : (
              <p>No tasks match these filters</p>
            )}
          </div>
        ) : (
          groups.map((group) => {
            const isOpen = !collapsed[group.key];
            return (
              <div key={group.key} className="task-group">
                <button
                  type="button"
                  className="task-group-header"
                  onClick={() => toggleCollapsed(group.key)}
                >
                  <span
                    className={`material-symbols-outlined task-group-chevron ${isOpen ? 'open' : ''}`}
                  >
                    chevron_right
                  </span>
                  <span className="task-group-label">{group.label}</span>
                  <span className="task-group-count">{group.items.length}</span>
                </button>
                {isOpen && (
                  <div className="task-items">
                    {group.items.map((task) => (
                      <TaskRow
                        key={`${task.file}-${task.line}`}
                        task={task}
                        onNavigate={() => onTaskClick(task.file, task.line)}
                        onToggleStatus={() => onToggleStatus(task)}
                        onOpenMetadata={(rect) => setPopover({ task, anchorRect: rect })}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {popover && (
        <TaskMetadataPopover
          key={`${popover.task.file}-${popover.task.line}`}
          anchorRect={popover.anchorRect}
          initial={popoverInitial}
          onChange={(value) => onUpdateMetadata(popover.task, value)}
          onClose={() => setPopover(null)}
          onNavigateToDate={onNavigateToDate}
        />
      )}
    </div>
  );
};

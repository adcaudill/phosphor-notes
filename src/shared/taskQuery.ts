/**
 * Which tasks a view shows, the search filter syntax, grouping and sorting -
 * pure functions over task summaries, shared by the Tasks tab and MCP.
 *
 * Filter syntax (combinable with free text, which is matched separately by
 * the full-text index):
 *   status:todo|doing|waiting|done|cancelled|open      priority:high|medium|low|none
 *   due:today|overdue|none|<7d|>2026-12-01|week          start:>today|none
 *   #tag   +Project   +"Multi Word"                     has:notes|checklist|comments
 *   repeat:yes|no   linked:yes|no   in:"Note name"     completed:today|week|last-week|month
 */
import type { TaskStatus } from './taskRecord';
import type { TaskSummary } from './taskViews';
import { addDays } from './taskRepeat';

export type TaskViewId =
  'inbox' | 'today' | 'upcoming' | 'anytime' | 'waiting' | 'scheduled' | 'logbook' | 'all';

export const TASK_VIEWS: Array<{ id: TaskViewId; label: string; icon: string; hint: string }> = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox', hint: 'No date or project yet' },
  { id: 'today', label: 'Today', icon: 'today', hint: 'Due today, overdue, or starting today' },
  { id: 'upcoming', label: 'Upcoming', icon: 'date_range', hint: 'The next 14 days' },
  { id: 'anytime', label: 'Anytime', icon: 'layers', hint: 'Open, with no due date' },
  { id: 'waiting', label: 'Waiting', icon: 'hourglass_empty', hint: 'Waiting on someone' },
  { id: 'scheduled', label: 'Scheduled', icon: 'event_upcoming', hint: 'Starting later' },
  { id: 'logbook', label: 'Logbook', icon: 'task_alt', hint: 'Done and cancelled' },
  { id: 'all', label: 'All', icon: 'list', hint: 'Every task' }
];

const UPCOMING_DAYS = 14;

export function isOpen(t: { status: TaskStatus }): boolean {
  return t.status === 'todo' || t.status === 'doing' || t.status === 'waiting';
}

const dueDate = (t: TaskSummary): string | undefined => t.due?.slice(0, 10);

/**
 * Open tasks due today or overdue - not waiting, not starting later. The
 * daily-note rollup and the Tasks badge in the sidebar.
 */
export function dueNow(tasks: TaskSummary[], today: string): TaskSummary[] {
  return tasks.filter((t) => {
    const due = dueDate(t);
    return (
      isOpen(t) &&
      t.status !== 'waiting' &&
      due !== undefined &&
      due <= today &&
      !(t.start && t.start > today)
    );
  });
}

/** True if the task belongs in a built-in view. */
export function inView(t: TaskSummary, view: TaskViewId, today: string): boolean {
  const due = dueDate(t);
  const deferred = Boolean(t.start && t.start > today);
  switch (view) {
    case 'inbox':
      return isOpen(t) && t.status !== 'waiting' && !due && !t.start && !t.project;
    case 'today':
      return (
        isOpen(t) &&
        !deferred &&
        t.status !== 'waiting' &&
        ((due !== undefined && due <= today) || t.start === today)
      );
    case 'upcoming':
      return isOpen(t) && due !== undefined && due > today && due <= addDays(today, UPCOMING_DAYS);
    case 'anytime':
      return isOpen(t) && t.status !== 'waiting' && !due && !deferred && !inView(t, 'inbox', today);
    case 'waiting':
      return t.status === 'waiting';
    case 'scheduled':
      return isOpen(t) && deferred;
    case 'logbook':
      return !isOpen(t);
    case 'all':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Filter syntax

export interface TaskFilter {
  /** Free text, for the full-text index. */
  text: string;
  test: (t: TaskSummary, ctx: { today: string }) => boolean;
  /** Each recognized filter term, for showing as chips. */
  terms: string[];
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function startOfWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7)); // Monday
}

/** A date condition: today, overdue, none, week, <7d, >=2026-12-01, ... */
function dateTest(spec: string, today: string): ((date: string | undefined) => boolean) | null {
  const s = spec.toLowerCase();
  if (s === 'none') return (d) => !d;
  if (s === 'any' || s === 'yes') return (d) => Boolean(d);
  if (s === 'today') return (d) => d === today;
  if (s === 'tomorrow') return (d) => d === addDays(today, 1);
  if (s === 'overdue') return (d) => Boolean(d && d < today);
  if (s === 'week') return (d) => Boolean(d && d >= today && d <= addDays(today, 7));
  const m = /^(<=|>=|<|>|=)?(today|\d+d|\d{4}-\d{2}-\d{2})$/.exec(s);
  if (!m) return null;
  const op = m[1] ?? '=';
  const target =
    m[2] === 'today' ? today : /d$/.test(m[2]) ? addDays(today, parseInt(m[2], 10)) : m[2];
  return (d) => {
    if (!d) return false;
    switch (op) {
      case '<':
        return d < target;
      case '<=':
        return d <= target;
      case '>':
        return d > target;
      case '>=':
        return d >= target;
      default:
        return d === target;
    }
  };
}

function completedTest(spec: string, today: string): ((at: string | undefined) => boolean) | null {
  const s = spec.toLowerCase();
  const day = (at: string | undefined): string | undefined => at?.slice(0, 10);
  if (s === 'today') return (at) => day(at) === today;
  if (s === 'yesterday') return (at) => day(at) === addDays(today, -1);
  if (s === 'week') return (at) => Boolean(day(at) && day(at)! >= startOfWeek(today));
  if (s === 'last-week') {
    const start = addDays(startOfWeek(today), -7);
    const end = startOfWeek(today);
    return (at) => Boolean(day(at) && day(at)! >= start && day(at)! < end);
  }
  if (s === 'month') return (at) => day(at)?.slice(0, 7) === today.slice(0, 7);
  const d = dateTest(s, today);
  return d ? (at) => d(day(at)) : null;
}

/** Splits a query into terms, keeping "quoted phrases" (also after a prefix: in:"Weekly Review"). */
function tokenize(query: string): string[] {
  return query.match(/(?:[^\s"]+)?"[^"]*"|\S+/g) ?? [];
}

const unquote = (s: string): string => s.replace(/^"|"$/g, '');

/** Parses the search box. Unrecognized words are free text for the full-text index. */
export function parseTaskFilter(query: string): TaskFilter {
  const tests: Array<TaskFilter['test']> = [];
  const text: string[] = [];
  const terms: string[] = [];

  for (const raw of tokenize(query)) {
    const term = raw.trim();
    const lower = term.toLowerCase();
    let m: RegExpExecArray | null;
    let test: TaskFilter['test'] | null = null;

    if ((m = /^status:(todo|doing|waiting|done|cancelled|open)$/i.exec(term))) {
      const want = m[1].toLowerCase();
      test = (t) => (want === 'open' ? isOpen(t) : t.status === want);
    } else if ((m = /^priority:(high|medium|med|low|none)$/i.exec(term))) {
      const want = m[1].toLowerCase().replace(/^med$/, 'medium');
      test = (t) => (want === 'none' ? !t.priority : t.priority === want);
    } else if ((m = /^due:(.+)$/i.exec(term))) {
      const d = dateTest(m[1], '');
      if (d) {
        const spec = m[1];
        test = (t, ctx) => (dateTest(spec, ctx.today) as (x?: string) => boolean)(dueDate(t));
      }
    } else if ((m = /^start:(.+)$/i.exec(term))) {
      if (dateTest(m[1], '')) {
        const spec = m[1];
        test = (t, ctx) => (dateTest(spec, ctx.today) as (x?: string) => boolean)(t.start);
      }
    } else if ((m = /^completed:(.+)$/i.exec(term))) {
      if (completedTest(m[1], '2000-01-01')) {
        const spec = m[1];
        test = (t, ctx) => (completedTest(spec, ctx.today) as (x?: string) => boolean)(t.completed);
      }
    } else if ((m = /^#(.+)$/.exec(term))) {
      const tag = m[1].toLowerCase();
      test = (t) => t.tags.some((x) => x.toLowerCase() === tag);
    } else if ((m = /^\+(.+)$/.exec(term))) {
      const project = unquote(m[1]).toLowerCase();
      test = (t) => (t.project ?? '').toLowerCase() === project;
    } else if ((m = /^has:(\w+)$/i.exec(term))) {
      const what = m[1].toLowerCase();
      if (what === 'notes') test = (t) => t.hasNotes;
      else if (what === 'checklist') test = (t) => t.checklist.length > 0;
      else if (what === 'comments') test = (t) => t.commentCount > 0;
    } else if ((m = /^repeat:(yes|no)$/i.exec(term))) {
      const want = m[1].toLowerCase() === 'yes';
      test = (t) => Boolean(t.repeat) === want;
    } else if ((m = /^linked:(yes|no)$/i.exec(term))) {
      const want = m[1].toLowerCase() === 'yes';
      test = (t) => t.linkCount > 0 === want;
    } else if ((m = /^in:(.+)$/i.exec(term))) {
      const note = unquote(m[1]).toLowerCase().replace(/\.md$/, '');
      test = (t) => t.linkedNotes.some((n) => n.toLowerCase().replace(/\.md$/, '') === note);
    }

    if (test) {
      tests.push(test);
      terms.push(term);
    } else if (lower) {
      text.push(unquote(term));
    }
  }

  return {
    text: text.join(' '),
    terms,
    test: (t, ctx) => tests.every((fn) => fn(t, ctx))
  };
}

// ---------------------------------------------------------------------------
// Sorting and grouping

export type TaskSort = 'manual' | 'due' | 'priority' | 'created' | 'updated' | 'title';

const ORDER_STEP = 1024;

/**
 * The order values to write so that the task at `from` ends up at `to` in
 * `list` (both indexes into `list`, in its current order). When the list
 * already has distinct order values, only the moved task changes (it takes a
 * value between its new neighbours); otherwise the whole list is numbered
 * once, in its new order.
 */
export function planReorder(
  list: Array<{ id: string; order?: number }>,
  from: number,
  to: number
): Array<{ id: string; order: number }> {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [];
  const moved = [...list];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);

  const orders = list.map((t) => t.order);
  const distinct =
    orders.every((o) => typeof o === 'number' && Number.isFinite(o)) &&
    new Set(orders).size === orders.length &&
    orders.every((o, i) => i === 0 || (o as number) > (orders[i - 1] as number));
  if (distinct) {
    const before = moved[to - 1]?.order;
    const after = moved[to + 1]?.order;
    const value =
      before === undefined
        ? (after as number) - ORDER_STEP
        : after === undefined
          ? before + ORDER_STEP
          : (before + after) / 2;
    // Midpoints eventually run out of room; renumber then instead.
    if (before === undefined || after === undefined || (value !== before && value !== after)) {
      return [{ id: item.id, order: value }];
    }
  }
  return moved.map((t, i) => ({ id: t.id, order: (i + 1) * ORDER_STEP }));
}
export type TaskGroup = 'none' | 'due' | 'project' | 'priority' | 'status' | 'tag';

const STATUS_ORDER: Record<TaskStatus, number> = {
  doing: 0,
  todo: 1,
  waiting: 2,
  done: 3,
  cancelled: 4
};

function compareDue(a: TaskSummary, b: TaskSummary): number {
  if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  return a.due ? -1 : b.due ? 1 : 0;
}

function comparePriority(a: TaskSummary, b: TaskSummary): number {
  return (PRIORITY_RANK[a.priority ?? ''] ?? 3) - (PRIORITY_RANK[b.priority ?? ''] ?? 3);
}

export function sortTasks(tasks: TaskSummary[], sort: TaskSort, view?: TaskViewId): TaskSummary[] {
  const byTitle = (a: TaskSummary, b: TaskSummary): number => a.title.localeCompare(b.title);
  const cmp: Record<TaskSort, (a: TaskSummary, b: TaskSummary) => number> = {
    // Ordered tasks first, in their order; the rest after, by due date.
    manual: (a, b) =>
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      compareDue(a, b) ||
      comparePriority(a, b) ||
      byTitle(a, b),
    due: (a, b) => compareDue(a, b) || comparePriority(a, b) || byTitle(a, b),
    priority: (a, b) => comparePriority(a, b) || compareDue(a, b) || byTitle(a, b),
    created: (a, b) => (b.created ?? '').localeCompare(a.created ?? '') || byTitle(a, b),
    updated: (a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || byTitle(a, b),
    title: byTitle
  };
  // The logbook reads newest-completed first, whatever else is chosen.
  const logbook = (a: TaskSummary, b: TaskSummary): number =>
    (b.completed ?? b.updated ?? '').localeCompare(a.completed ?? a.updated ?? '');
  return [...tasks].sort(view === 'logbook' ? logbook : cmp[sort]);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayHeading(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}${String(y) === today.slice(0, 4) ? '' : `, ${y}`}`;
}

export interface TaskGroupSection {
  key: string;
  label: string;
  tasks: TaskSummary[];
}

/** Groups (already sorted) tasks into labelled sections, in a sensible order. */
export function groupTasks(
  tasks: TaskSummary[],
  group: TaskGroup,
  today: string,
  view?: TaskViewId
): TaskGroupSection[] {
  if (view === 'logbook') {
    return sections(
      tasks,
      (t) => {
        const day = (t.completed ?? t.updated ?? '').slice(0, 10);
        return day ? [day, dayHeading(day, today)] : ['', 'Earlier'];
      },
      (a, b) => b.localeCompare(a)
    );
  }
  if (view === 'upcoming' && (group === 'due' || group === 'none')) {
    return sections(tasks, (t) => {
      const d = dueDate(t) as string;
      return [d, dayHeading(d, today)];
    });
  }
  switch (group) {
    case 'none':
      return tasks.length ? [{ key: 'all', label: '', tasks }] : [];
    case 'due':
      return sections(tasks, (t) => {
        const d = dueDate(t);
        if (!d) return ['5', 'No date'];
        if (d < today) return ['0', 'Overdue'];
        if (d === today) return ['1', 'Today'];
        if (d === addDays(today, 1)) return ['2', 'Tomorrow'];
        if (d <= addDays(today, 7)) return ['3', 'This week'];
        return ['4', 'Later'];
      });
    case 'project':
      return sections(tasks, (t) =>
        t.project ? [`0${t.project.toLowerCase()}`, t.project] : ['1', 'No project']
      );
    case 'priority':
      return sections(tasks, (t) =>
        t.priority
          ? [
              String(PRIORITY_RANK[t.priority]),
              `${t.priority[0].toUpperCase()}${t.priority.slice(1)} priority`
            ]
          : ['3', 'No priority']
      );
    case 'status':
      return sections(tasks, (t) => [
        String(STATUS_ORDER[t.status]),
        { todo: 'To do', doing: 'Doing', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' }[
          t.status
        ]
      ]);
    case 'tag': {
      // A task with several tags appears under each.
      const out = new Map<string, TaskGroupSection>();
      for (const t of tasks) {
        const tags = t.tags.length ? t.tags : [''];
        for (const tag of tags) {
          const key = tag ? `0${tag.toLowerCase()}` : '1';
          if (!out.has(key)) out.set(key, { key, label: tag ? `#${tag}` : 'No tags', tasks: [] });
          out.get(key)!.tasks.push(t);
        }
      }
      return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
  }
}

function sections(
  tasks: TaskSummary[],
  keyOf: (t: TaskSummary) => [string, string],
  order: (a: string, b: string) => number = (a, b) => a.localeCompare(b)
): TaskGroupSection[] {
  const out = new Map<string, TaskGroupSection>();
  for (const t of tasks) {
    const [key, label] = keyOf(t);
    if (!out.has(key)) out.set(key, { key, label, tasks: [] });
    out.get(key)!.tasks.push(t);
  }
  return [...out.values()].sort((a, b) => order(a.key, b.key));
}

/** Counts for the view sidebar (open tasks only, except the logbook and all). */
export function viewCounts(tasks: TaskSummary[], today: string): Record<TaskViewId, number> {
  const counts = Object.fromEntries(TASK_VIEWS.map((v) => [v.id, 0])) as Record<TaskViewId, number>;
  for (const t of tasks) for (const v of TASK_VIEWS) if (inView(t, v.id, today)) counts[v.id]++;
  return counts;
}

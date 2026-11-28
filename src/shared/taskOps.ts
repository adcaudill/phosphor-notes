/**
 * Operations on task records - the one place that decides what creating,
 * editing, completing, skipping or commenting on a task does to its fields
 * and activity log. Pure: each takes a record and returns a new one, so the
 * main process (taskStore, MCP) and tests share exactly the same behavior.
 */
import {
  type ChecklistItem,
  type TaskLogEvent,
  type TaskPriority,
  type TaskRecord,
  type TaskRepeat,
  type TaskStatus,
  TaskFileError,
  datePart,
  localDate,
  localDateTime,
  validateTaskRecord
} from './taskRecord';
import { addDays, daysBetween, nextOccurrence } from './taskRepeat';

export interface NewTaskInput {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due?: string;
  start?: string;
  repeat?: TaskRepeat;
  project?: string;
  tags?: string[];
  waitingOn?: string;
  notes?: string;
  checklist?: ChecklistItem[];
}

/** Field changes; `null` clears an optional field. */
export interface TaskPatch {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority | null;
  due?: string | null;
  start?: string | null;
  repeat?: TaskRepeat | null;
  project?: string | null;
  tags?: string[];
  waitingOn?: string | null;
  notes?: string;
  checklist?: ChecklistItem[];
}

function cleanTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const tag = t.trim().replace(/^#/, '');
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function withEvent(task: TaskRecord, event: TaskLogEvent): TaskRecord {
  return { ...task, log: [...task.log, event] };
}

function stamp(task: TaskRecord, now: Date): TaskRecord {
  return { ...task, updated: localDateTime(now) };
}

/** A new task record (not yet written). */
export function createTaskRecord(
  input: NewTaskInput,
  id: string,
  now: Date = new Date()
): TaskRecord {
  const at = localDateTime(now);
  const task: TaskRecord = {
    id,
    title: (input.title ?? '').trim(),
    status: input.status ?? 'todo',
    tags: cleanTags(input.tags),
    checklist: input.checklist ?? [],
    log: [{ at, type: 'created' }],
    notes: input.notes ?? '',
    extra: {},
    created: at,
    updated: at
  };
  if (input.priority) task.priority = input.priority;
  if (input.due) task.due = input.due;
  if (input.start) task.start = input.start;
  if (input.repeat) task.repeat = { ...input.repeat };
  if (input.project?.trim()) task.project = input.project.trim();
  if (input.waitingOn?.trim()) task.waitingOn = input.waitingOn.trim();
  if (task.status === 'done') task.completed = at;
  validateTaskRecord(task);
  return task;
}

/**
 * Completes the current occurrence. A repeating task with a due date moves
 * to its next occurrence (status back to todo, start date shifted by the same
 * amount, checklist reset) and logs the completion; anything else - or the
 * last occurrence of a series - becomes done.
 */
export function completeTask(task: TaskRecord, now: Date = new Date()): TaskRecord {
  const at = localDateTime(now);
  const today = localDate(now);
  const occurrence = task.due ? datePart(task.due) : undefined;
  const event: TaskLogEvent = { at, type: 'completed', ...(occurrence ? { occurrence } : {}) };

  if (task.repeat && task.due) {
    const next = nextOccurrence(task.repeat, task.due, { completedOn: today, today });
    if (next.due) {
      const shift = daysBetween(datePart(task.due), datePart(next.due));
      const repeat = { ...task.repeat };
      if (next.count !== undefined) repeat.count = next.count;
      const advanced: TaskRecord = {
        ...task,
        status: 'todo',
        due: next.due,
        repeat,
        completed: at,
        checklist: task.checklist.map((c) => ({ ...c, done: false }))
      };
      if (task.start) advanced.start = addDays(task.start, shift);
      return stamp(withEvent(advanced, event), now);
    }
  }
  const done: TaskRecord = { ...task, status: 'done', completed: at };
  return stamp(withEvent(done, event), now);
}

/** Skips the current occurrence of a repeating task. Skipping the last one cancels the series. */
export function skipOccurrence(task: TaskRecord, now: Date = new Date()): TaskRecord {
  if (!task.repeat || !task.due)
    throw new TaskFileError('only a repeating task with a due date can skip');
  const at = localDateTime(now);
  const today = localDate(now);
  const occurrence = datePart(task.due);
  const next = nextOccurrence(task.repeat, task.due, { completedOn: today, today });
  const event: TaskLogEvent = { at, type: 'skipped', occurrence };
  if (!next.due) {
    return stamp(withEvent({ ...task, status: 'cancelled' }, event), now);
  }
  const shift = daysBetween(occurrence, datePart(next.due));
  const repeat = { ...task.repeat };
  if (next.count !== undefined) repeat.count = next.count;
  const advanced: TaskRecord = { ...task, due: next.due, repeat };
  if (task.start) advanced.start = addDays(task.start, shift);
  return stamp(withEvent(advanced, event), now);
}

/** Changes status, logging it. Moving to done completes (repeat-aware); leaving done clears the completion time. */
export function setStatus(
  task: TaskRecord,
  status: TaskStatus,
  now: Date = new Date()
): TaskRecord {
  if (status === task.status) return task;
  if (status === 'done') return completeTask(task, now);
  const event: TaskLogEvent = {
    at: localDateTime(now),
    type: 'status',
    from: task.status,
    to: status
  };
  const next: TaskRecord = { ...task, status };
  if (task.status === 'done') delete next.completed;
  return stamp(withEvent(next, event), now);
}

/** Applies field changes. Status goes through setStatus; a changed due date is logged as a reschedule. */
export function applyTaskPatch(
  task: TaskRecord,
  patch: TaskPatch,
  now: Date = new Date()
): TaskRecord {
  let next: TaskRecord = { ...task };
  const at = localDateTime(now);

  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.checklist !== undefined) next.checklist = patch.checklist.map((c) => ({ ...c }));
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);

  const optional: Array<[keyof TaskPatch & keyof TaskRecord, unknown]> = [
    ['priority', patch.priority],
    ['start', patch.start],
    ['repeat', patch.repeat],
    ['project', patch.project],
    ['waitingOn', patch.waitingOn]
  ];
  for (const [key, value] of optional) {
    if (value === undefined) continue;
    if (value === null || value === '') delete (next as unknown as Record<string, unknown>)[key];
    else
      (next as unknown as Record<string, unknown>)[key] =
        typeof value === 'string' ? value.trim() : value;
  }

  if (patch.due !== undefined) {
    const to = patch.due === null || patch.due === '' ? undefined : patch.due;
    if (to !== task.due) {
      if (to === undefined) delete next.due;
      else next.due = to;
      next = withEvent(next, { at, type: 'rescheduled', from: task.due ?? null, to: to ?? null });
    }
  }

  if (patch.status !== undefined && patch.status !== next.status) {
    next = setStatus(next, patch.status, now);
  }

  next = stamp(next, now);
  validateTaskRecord(next);
  return next;
}

export function addComment(task: TaskRecord, text: string, now: Date = new Date()): TaskRecord {
  const body = text.trim();
  if (!body) throw new TaskFileError('a comment needs some text');
  return stamp(withEvent(task, { at: localDateTime(now), type: 'comment', text: body }), now);
}

/** Edits the text of the comment logged at `at` (comments are the only editable log entries). */
export function editComment(
  task: TaskRecord,
  at: string,
  text: string,
  now: Date = new Date()
): TaskRecord {
  const body = text.trim();
  if (!body) throw new TaskFileError('a comment needs some text');
  let found = false;
  const log = task.log.map((e) => {
    if (!found && e.type === 'comment' && e.at === at) {
      found = true;
      return { ...e, text: body, edited: localDateTime(now) };
    }
    return e;
  });
  if (!found) throw new TaskFileError(`no comment at ${at}`);
  return stamp({ ...task, log }, now);
}

export function deleteComment(task: TaskRecord, at: string, now: Date = new Date()): TaskRecord {
  const log = task.log.filter((e) => !(e.type === 'comment' && e.at === at));
  if (log.length === task.log.length) throw new TaskFileError(`no comment at ${at}`);
  return stamp({ ...task, log }, now);
}

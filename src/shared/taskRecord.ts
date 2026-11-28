/**
 * Task files: one task per `_tasks/<id>.md` file, Markdown with YAML
 * frontmatter. The frontmatter holds the structured fields, the checklist and
 * the activity log; the body holds free-form notes.
 *
 * This module is pure (no fs, no Electron): types, paths and ids, a strict
 * parser and a canonical serializer. It runs in the main process, the
 * renderer and tests alike. File I/O lives in src/main/taskStore.ts; task
 * operations (complete, reschedule, comment, ...) in src/shared/taskOps.ts.
 *
 * This is the task-file model. The older inline checkbox syntax
 * (`- [ ] text 📅 ...`, src/shared/tasks.ts) is a separate, legacy thing.
 */
import { Document, parse as parseYaml, isMap, isSeq, YAMLMap, YAMLSeq } from 'yaml';
import { isValidRepeatRule } from './taskRepeat';

export const TASKS_DIR = '_tasks';

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
export type TaskPriority = 'high' | 'medium' | 'low';
export type RepeatFrom = 'due' | 'completion';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'doing',
  'waiting',
  'done',
  'cancelled'
];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['high', 'medium', 'low'];

export interface TaskRepeat {
  /** iCalendar RRULE (without the `RRULE:` prefix), e.g. `FREQ=MONTHLY;BYMONTHDAY=1`. */
  rule: string;
  /** `due`: a fixed schedule. `completion`: the next date is counted from when it was completed. */
  from: RepeatFrom;
  /** No occurrences after this date (YYYY-MM-DD). */
  until?: string;
  /** Occurrences remaining, including the current one. Completing the last one ends the series. */
  count?: number;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface TaskLogEvent {
  /** Local datetime, YYYY-MM-DDTHH:MM:SS. */
  at: string;
  /** created | status | completed | skipped | rescheduled | comment | ... (unknown types are kept). */
  type: string;
  /** Event-specific fields (from/to, occurrence, text, ...). */
  [key: string]: unknown;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: TaskPriority;
  /** YYYY-MM-DD, or YYYY-MM-DDTHH:MM for "due at". */
  due?: string;
  /** YYYY-MM-DD: hidden from Today/Upcoming until this date. */
  start?: string;
  repeat?: TaskRepeat;
  project?: string;
  tags: string[];
  waitingOn?: string;
  /** Position for manual ordering in the Tasks tab (lower first); absent until the person orders it. */
  order?: number;
  created?: string;
  updated?: string;
  /** When it was last completed (for a repeating task, the latest occurrence). */
  completed?: string;
  checklist: ChecklistItem[];
  log: TaskLogEvent[];
  /** The Markdown body: free-form notes. */
  notes: string;
  /** Frontmatter keys this version doesn't know, kept untouched on rewrite. */
  extra: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Paths and ids

/** 32 characters: a-z and 2-9, without the easily-confused l, o, 0 and 1. */
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const ID_LENGTH = 8;
const ID_RE = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

export function isValidTaskId(id: string): boolean {
  return ID_RE.test(id);
}

/** A random task id (about 1.1e12 possibilities). Callers check for an existing file and retry. */
export function generateTaskId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

/** Vault-relative path of a task's file, e.g. `_tasks/k3f9a2xq.md`. */
export function taskFilePath(id: string): string {
  return `${TASKS_DIR}/${id}.md`;
}

/** True for any path inside the vault's `_tasks/` folder (with either separator). */
export function isTaskFilePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return p === TASKS_DIR || p.startsWith(`${TASKS_DIR}/`);
}

/** The task id for a `_tasks/<id>.md` path, or null if the path isn't a task file. */
export function taskIdFromPath(relPath: string): string | null {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const m = new RegExp(`^${TASKS_DIR}/([^/]+)\\.md$`).exec(p);
  return m && isValidTaskId(m[1]) ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Dates

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DUE_RE = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** A due value: a date, optionally with a time (YYYY-MM-DDTHH:MM). */
export function isValidDue(value: string): boolean {
  const m = DUE_RE.exec(value);
  return Boolean(m && isValidDate(m[1]));
}

/** A timestamp: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS. */
export function isValidDateTime(value: string): boolean {
  const m = DATETIME_RE.exec(value);
  return Boolean(m && isValidDate(m[1]));
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local date, YYYY-MM-DD. */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local datetime, YYYY-MM-DDTHH:MM:SS. */
export function localDateTime(now: Date = new Date()): string {
  return `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** The date part of a due/datetime value. */
export function datePart(value: string): string {
  return value.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Parsing

export class TaskFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskFileError';
  }
}

export type ParseTaskResult = { ok: true; task: TaskRecord } | { ok: false; error: string };

const KNOWN_KEYS = new Set([
  'id',
  'title',
  'status',
  'priority',
  'due',
  'start',
  'repeat',
  'project',
  'tags',
  'waiting_on',
  'order',
  'created',
  'updated',
  'completed',
  'checklist',
  'log'
]);

function splitFrontmatter(text: string): { yaml: string; body: string } {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) {
    throw new TaskFileError('missing frontmatter (the file must start with ---)');
  }
  const close = src.indexOf('\n---', 3);
  if (close === -1) throw new TaskFileError('frontmatter is not closed (no ending ---)');
  const afterClose = close + 4;
  // The closing delimiter must be a line of its own.
  if (afterClose < src.length && src[afterClose] !== '\n') {
    throw new TaskFileError('frontmatter is not closed (no ending ---)');
  }
  const yaml = src.slice(4, close + 1);
  let body = src.slice(afterClose + 1);
  if (body.startsWith('\n')) body = body.slice(1);
  return { yaml, body: body.replace(/\s+$/, '') };
}

/** Scalars YAML may have typed (a title of `2026`, a tag of `true`) read back as text. */
function asText(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TaskFileError(`${field} must be text`);
}

function optionalText(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return undefined;
  return asText(v, key);
}

function parseRepeat(value: unknown): TaskRepeat | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskFileError('repeat must be a mapping with a rule');
  }
  const r = value as Record<string, unknown>;
  const rule = asText(r.rule, 'repeat.rule')
    .replace(/^RRULE:/i, '')
    .trim();
  if (!isValidRepeatRule(rule)) throw new TaskFileError(`repeat.rule is not a valid rule: ${rule}`);
  const from = r.from === undefined ? 'due' : asText(r.from, 'repeat.from');
  if (from !== 'due' && from !== 'completion') {
    throw new TaskFileError('repeat.from must be "due" or "completion"');
  }
  const repeat: TaskRepeat = { rule, from };
  if (r.until !== undefined && r.until !== null) {
    const until = asText(r.until, 'repeat.until');
    if (!isValidDate(until)) throw new TaskFileError('repeat.until must be a date (YYYY-MM-DD)');
    repeat.until = until;
  }
  if (r.count !== undefined && r.count !== null) {
    if (typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 1) {
      throw new TaskFileError('repeat.count must be a whole number of at least 1');
    }
    repeat.count = r.count;
  }
  return repeat;
}

function parseChecklist(value: unknown): ChecklistItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TaskFileError('checklist must be a list');
  return value.map((item, i) => {
    if (typeof item === 'string') return { text: item, done: false };
    if (!item || typeof item !== 'object') {
      throw new TaskFileError(`checklist item ${i + 1} must have text`);
    }
    const it = item as Record<string, unknown>;
    return { text: asText(it.text, `checklist item ${i + 1}`), done: it.done === true };
  });
}

function parseLog(value: unknown): TaskLogEvent[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TaskFileError('log must be a list');
  return value.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TaskFileError(`log entry ${i + 1} must be a mapping`);
    }
    const e = item as Record<string, unknown>;
    const at = asText(e.at, `log entry ${i + 1} "at"`);
    const type = asText(e.type, `log entry ${i + 1} "type"`);
    return { ...e, at, type };
  });
}

/**
 * Parses a task file. `fileId` (from the filename) wins over the `id` field
 * when they differ; the next write repairs the field. Errors describe what's
 * wrong, for the Tasks tab's problems list. Never throws.
 */
export function parseTaskFile(text: string, fileId: string): ParseTaskResult {
  try {
    const { yaml, body } = splitFrontmatter(text);
    let data: unknown;
    try {
      data = parseYaml(yaml);
    } catch (err) {
      throw new TaskFileError(`frontmatter is not valid YAML: ${(err as Error).message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TaskFileError('frontmatter must be a set of fields');
    }
    const fm = data as Record<string, unknown>;

    const title = optionalText(fm, 'title');
    if (!title || !title.trim()) throw new TaskFileError('title is required');

    const status = fm.status === undefined ? 'todo' : asText(fm.status, 'status');
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      throw new TaskFileError(`status must be one of ${TASK_STATUSES.join(', ')}`);
    }

    const priority = optionalText(fm, 'priority');
    if (priority !== undefined && !TASK_PRIORITIES.includes(priority as TaskPriority)) {
      throw new TaskFileError(`priority must be one of ${TASK_PRIORITIES.join(', ')}`);
    }

    const due = optionalText(fm, 'due');
    if (due !== undefined && !isValidDue(due)) {
      throw new TaskFileError(
        'due must be a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:MM)'
      );
    }
    const start = optionalText(fm, 'start');
    if (start !== undefined && !isValidDate(start)) {
      throw new TaskFileError('start must be a date (YYYY-MM-DD)');
    }

    let tags: string[] = [];
    if (fm.tags !== undefined && fm.tags !== null) {
      const raw = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      tags = raw.map((t) => asText(t, 'tags').trim()).filter((t) => t.length > 0);
    }

    const stamps: Record<string, string | undefined> = {};
    for (const key of ['created', 'updated', 'completed']) {
      const v = optionalText(fm, key);
      if (v !== undefined && !isValidDateTime(v)) {
        throw new TaskFileError(`${key} must be a date and time (YYYY-MM-DDTHH:MM:SS)`);
      }
      stamps[key] = v;
    }

    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (!KNOWN_KEYS.has(k)) extra[k] = v;
    }

    const task: TaskRecord = {
      id: fileId,
      title: title.trim(),
      status: status as TaskStatus,
      tags,
      checklist: parseChecklist(fm.checklist),
      log: parseLog(fm.log),
      notes: body,
      extra
    };
    if (priority) task.priority = priority as TaskPriority;
    if (due) task.due = due;
    if (start) task.start = start;
    const repeat = parseRepeat(fm.repeat);
    if (repeat) task.repeat = repeat;
    const project = optionalText(fm, 'project');
    if (project) task.project = project.trim();
    const waitingOn = optionalText(fm, 'waiting_on');
    if (waitingOn) task.waitingOn = waitingOn;
    if (fm.order !== undefined && fm.order !== null) {
      if (typeof fm.order !== 'number' || !Number.isFinite(fm.order)) {
        throw new TaskFileError('order must be a number');
      }
      task.order = fm.order;
    }
    if (stamps.created) task.created = stamps.created;
    if (stamps.updated) task.updated = stamps.updated;
    if (stamps.completed) task.completed = stamps.completed;
    return { ok: true, task };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Serializing

/** Throws TaskFileError if `task` couldn't be written as a valid file (the same rules the parser applies). */
export function validateTaskRecord(task: TaskRecord): void {
  if (!isValidTaskId(task.id)) throw new TaskFileError(`invalid task id: ${task.id}`);
  if (!task.title || !task.title.trim()) throw new TaskFileError('title is required');
  if (/[\r\n]/.test(task.title)) throw new TaskFileError('title must be a single line');
  if (!TASK_STATUSES.includes(task.status))
    throw new TaskFileError(`invalid status: ${task.status}`);
  if (task.priority && !TASK_PRIORITIES.includes(task.priority)) {
    throw new TaskFileError(`invalid priority: ${task.priority}`);
  }
  if (task.due !== undefined && !isValidDue(task.due)) {
    throw new TaskFileError(`invalid due date: ${task.due}`);
  }
  if (task.start !== undefined && !isValidDate(task.start)) {
    throw new TaskFileError(`invalid start date: ${task.start}`);
  }
  if (task.order !== undefined && !Number.isFinite(task.order)) {
    throw new TaskFileError(`invalid order: ${task.order}`);
  }
  if (task.repeat) {
    if (!isValidRepeatRule(task.repeat.rule)) {
      throw new TaskFileError(`invalid repeat rule: ${task.repeat.rule}`);
    }
    if (task.repeat.until !== undefined && !isValidDate(task.repeat.until)) {
      throw new TaskFileError(`invalid repeat end date: ${task.repeat.until}`);
    }
  }
}

/**
 * Writes a task as its canonical file text: fixed key order, empty optional
 * fields left out, tags and checklist/log entries on one line each, no line
 * folding - so diffs and history stay readable. Unknown fields (`extra`)
 * come after the known ones, untouched.
 */
export function serializeTaskFile(task: TaskRecord): string {
  validateTaskRecord(task);
  const fm: Record<string, unknown> = { id: task.id, title: task.title, status: task.status };
  if (task.priority) fm.priority = task.priority;
  if (task.due) fm.due = task.due;
  if (task.start) fm.start = task.start;
  if (task.repeat) {
    const r: Record<string, unknown> = { rule: task.repeat.rule, from: task.repeat.from };
    if (task.repeat.until) r.until = task.repeat.until;
    if (task.repeat.count !== undefined) r.count = task.repeat.count;
    fm.repeat = r;
  }
  if (task.project) fm.project = task.project;
  if (task.tags.length > 0) fm.tags = task.tags;
  if (task.waitingOn) fm.waiting_on = task.waitingOn;
  if (task.order !== undefined) fm.order = task.order;
  if (task.created) fm.created = task.created;
  if (task.updated) fm.updated = task.updated;
  if (task.completed) fm.completed = task.completed;
  if (task.checklist.length > 0) {
    fm.checklist = task.checklist.map((c) => ({ text: c.text, done: c.done }));
  }
  if (task.log.length > 0) {
    // `at` and `type` first, then the event's own fields in their order.
    fm.log = task.log.map(({ at, type, ...rest }) => ({ at, type, ...rest }));
  }
  for (const [k, v] of Object.entries(task.extra)) {
    if (!(k in fm)) fm[k] = v;
  }

  const doc = new Document(fm);
  const root = doc.contents;
  if (isMap(root)) {
    const tags = root.get('tags', true);
    if (isSeq(tags)) (tags as YAMLSeq).flow = true;
    for (const key of ['checklist', 'log']) {
      const seq = root.get(key, true);
      if (isSeq(seq)) {
        for (const item of (seq as YAMLSeq).items) {
          if (isMap(item)) (item as YAMLMap).flow = true;
        }
      }
    }
  }
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: true });
  const notes = task.notes.replace(/\s+$/, '');
  return `---\n${yaml}---\n${notes ? `${notes}\n` : ''}`;
}

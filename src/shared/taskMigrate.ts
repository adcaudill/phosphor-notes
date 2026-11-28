/**
 * Converting inline checkbox tasks with metadata into task files - the pure
 * part: what a note's task lines become, and the note text afterwards.
 * File I/O is in src/main/taskMigration.ts.
 *
 * Converted: a `- [ ]` / `- [/]` / `- [x]` line carrying any task metadata -
 * 📅 🔁 🔺 🔼 🔽 ✓, @due() / @repeat(), DEADLINE: / SCHEDULED: <...>, and the
 * Logseq importer's @start() / @status(). Plain checkboxes (no metadata) are
 * checklist items and stay as they are.
 *
 * The old repeat model completed a repeating task by inserting a fresh copy
 * below the completed one, so a note can hold a done line per past
 * occurrence plus the open current one. Those history lines (same text and
 * same repeat as an open task in the same note) are folded into that task's
 * activity log as completions, and removed from the note.
 */
import { parseTaskLine, TASK_LINE_RE } from './tasks';
import type { TaskLogEvent, TaskRecord, TaskStatus } from './taskRecord';
import { isValidDate } from './taskRecord';
import { intervalRule } from './taskRepeat';
import type { NewTaskInput } from './taskOps';
import { formatTaskLink } from './taskLinks';

export interface PlannedTask {
  /** 0-based line index in the note. */
  line: number;
  /** The line as it was (to verify it hasn't changed before rewriting). */
  raw: string;
  indent: string;
  input: NewTaskInput & { status: TaskStatus };
  /** Completion time (local datetime) for a converted done task. */
  completed?: string;
  /** Extra activity: folded-in completions of a repeating task, notes about the conversion. */
  log: TaskLogEvent[];
}

export interface NotePlan {
  tasks: PlannedTask[];
  /** History lines folded into a repeating task: removed from the note. */
  removed: Array<{ line: number; raw: string }>;
}

const METADATA_RE =
  /📅|🔁|🔺|🔼|🔽|✓\s*\d{4}-\d{2}-\d{2}|@due\(|@repeat\(|@start\(|@status\(|DEADLINE:\s*</u;
const START_RE = /@start\((\d{4}-\d{2}-\d{2})\)/;
const STATUS_RE = /@status\((waiting|cancelled|canceled)\)/i;
const SCHEDULED_RE = /SCHEDULED:\s*<(\d{4}-\d{2}-\d{2})[^>]*>/i;

/** True if a line is an inline task with metadata (a conversion candidate). */
export function isConvertibleTaskLine(line: string): boolean {
  return TASK_LINE_RE.test(line) && METADATA_RE.test(line);
}

const UNIT_WORDS: Record<string, string> = { h: 'hours', M: 'minutes', S: 'seconds' };

function toDateTime(stamp: string | undefined): string | undefined {
  // "2026-01-12 14:30:45" -> "2026-01-12T14:30:45"
  return stamp ? stamp.replace(' ', 'T') : undefined;
}

function cleanTitle(text: string): string {
  return text
    .replace(START_RE, '')
    .replace(STATUS_RE, '')
    .replace(/DEADLINE:\s*<[^>]*>/gi, '')
    .replace(/SCHEDULED:\s*<[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function planLine(
  line: string,
  index: number,
  today: string,
  nowStamp: string
): PlannedTask | null {
  const m = TASK_LINE_RE.exec(line);
  const parsed = parseTaskLine(line);
  if (!m || !parsed || !METADATA_RE.test(line)) return null;

  let status: TaskStatus = parsed.status;
  const statusMark = STATUS_RE.exec(line);
  if (statusMark) status = statusMark[1].toLowerCase() === 'waiting' ? 'waiting' : 'cancelled';

  const input: PlannedTask['input'] = {
    title: cleanTitle(parsed.text) || 'Untitled task',
    status
  };
  if (parsed.dueDate && isValidDate(parsed.dueDate)) input.due = parsed.dueDate;
  const start = START_RE.exec(line)?.[1] ?? SCHEDULED_RE.exec(line)?.[1];
  if (start && isValidDate(start) && start !== input.due) input.start = start;
  if (parsed.priority) input.priority = parsed.priority;

  const log: TaskLogEvent[] = [];
  if (parsed.recurrence?.supported) {
    input.repeat = {
      rule: intervalRule(parsed.recurrence.amount, parsed.recurrence.unit, input.due ?? today),
      from: 'due'
    };
  } else if (parsed.recurrence) {
    log.push({
      at: nowStamp,
      type: 'comment',
      text: `Converted from an inline task that repeated every ${parsed.recurrence.amount} ${
        UNIT_WORDS[parsed.recurrence.unit] ?? parsed.recurrence.unit
      }. Repeats shorter than a day aren't supported, so it no longer repeats.`
    });
  }

  const completed = status === 'done' ? (toDateTime(parsed.completedAt) ?? nowStamp) : undefined;
  if (status === 'done') {
    log.push({
      at: completed as string,
      type: 'completed',
      ...(input.due ? { occurrence: input.due } : {})
    });
  }
  return { line: index, raw: line, indent: m[1], input, completed, log };
}

/** Plans the conversion of one note's text. `nowStamp` is a local datetime (YYYY-MM-DDTHH:MM:SS). */
export function planNoteMigration(doc: string, today: string, nowStamp: string): NotePlan {
  const lines = doc.split('\n');
  const planned: PlannedTask[] = [];
  lines.forEach((line, i) => {
    const p = planLine(line, i, today, nowStamp);
    if (p) planned.push(p);
  });

  // Fold the history lines of a repeating task into its open occurrence.
  const removed: NotePlan['removed'] = [];
  const keyOf = (p: PlannedTask): string | null =>
    p.input.repeat ? `${p.input.title}\u0000${p.input.repeat.rule}` : null;
  const openByKey = new Map<string, PlannedTask>();
  for (const p of planned) {
    const key = keyOf(p);
    if (key && p.input.status !== 'done' && p.input.status !== 'cancelled' && !openByKey.has(key)) {
      openByKey.set(key, p);
    }
  }
  const tasks: PlannedTask[] = [];
  for (const p of planned) {
    const key = keyOf(p);
    const open = key ? openByKey.get(key) : undefined;
    if (open && open !== p && p.input.status === 'done') {
      open.log.push(...p.log.filter((e) => e.type === 'completed'));
      removed.push({ line: p.line, raw: p.raw });
    } else {
      tasks.push(p);
    }
  }
  for (const t of tasks) t.log.sort((a, b) => a.at.localeCompare(b.at));
  return { tasks, removed };
}

/**
 * The note text after conversion: each converted line becomes a bullet
 * linking its task (`ids[i]` and `titles[i]` for `plan.tasks[i]`), and folded
 * history lines are removed. Throws if any line no longer matches the plan.
 */
export function applyNoteMigration(
  doc: string,
  plan: NotePlan,
  created: Array<{ id: string; title: string }>
): string {
  const lines = doc.split('\n');
  const edits = new Map<number, string | null>();
  plan.tasks.forEach((t, i) => {
    if (lines[t.line] !== t.raw) throw new Error(`line ${t.line + 1} changed since it was read`);
    edits.set(t.line, `${t.indent}- ${formatTaskLink(created[i].id, created[i].title)}`);
  });
  for (const r of plan.removed) {
    if (lines[r.line] !== r.raw) throw new Error(`line ${r.line + 1} changed since it was read`);
    edits.set(r.line, null);
  }
  const out: string[] = [];
  lines.forEach((line, i) => {
    const edit = edits.get(i);
    if (edit === undefined) out.push(line);
    else if (edit !== null) out.push(edit);
  });
  return out.join('\n');
}

/** Applies a planned task's conversion-only fields (completion, log) to a freshly created record. */
export function withMigratedHistory(
  record: TaskRecord,
  planned: PlannedTask,
  source: string
): TaskRecord {
  const created = record.log.find((e) => e.type === 'created');
  return {
    ...record,
    ...(planned.completed ? { completed: planned.completed } : {}),
    log: [
      ...(created ? [{ ...created, source }] : []),
      ...planned.log,
      ...record.log.filter((e) => e.type !== 'created')
    ]
  };
}

/**
 * Canonical task markdown parsing, serialization, and recurrence logic.
 * The single source of truth for the task-checkbox syntax, used identically
 * by the renderer, the main process, and the indexer worker thread - see
 * src/shared/wikilinks.ts for the same shared-module pattern this follows,
 * including the dev-mode runtime-inlining treatment in src/main/indexer.ts
 * (which must be extended to this file too; see the comment there).
 *
 * Syntax (all inline on the checkbox line itself, no frontmatter/block):
 *   - [ ] / - [/] / - [x]   status: todo / doing / done
 *   🔺 🔼 🔽                priority: high / medium / low (written; new)
 *   📅 YYYY-MM-DD            due date (written; canonical)
 *   🔁 +Nd / +Nw / +Nm / +Ny recurrence (written; canonical)
 *   ✓ YYYY-MM-DD HH:MM:SS   completion timestamp (written)
 *
 * Read-only, import-provenance formats (never written by this app, but must
 * keep parsing correctly forever - see the Phase 1 backward-compatibility
 * table in the task-system redesign plan):
 *   @due(YYYY-MM-DD), @repeat(N<unit>), DEADLINE: <YYYY-MM-DD ...>
 * `SCHEDULED: <...>` (Org) is deliberately left unparsed as a dedicated
 * field - it's never stripped from the display text and never surfaced
 * anywhere, so it's kept as inert text, exactly as today.
 */
import { InvalidArgumentError } from './noteFormat';

export type Status = 'todo' | 'doing' | 'done';
export type Priority = 'high' | 'medium' | 'low';

/** The only units the app ever writes/computes recurrence in. */
export type RecurrenceUnit = 'd' | 'w' | 'm' | 'y';

/**
 * `h`/`M`/`S` (hours/minutes/seconds) only ever arrive via legacy Logseq
 * `@repeat()` imports - kept case-sensitively distinct (`m` months vs `M`
 * minutes) so they're never conflated, and always `supported: false` so
 * nothing ever tries to compute a next occurrence for them.
 */
export type Recurrence =
  | { amount: number; unit: RecurrenceUnit; supported: true }
  | { amount: number; unit: 'h' | 'M' | 'S'; raw: string; supported: false };

export interface Task {
  file: string;
  line: number; // 1-indexed; a snapshot, can drift under concurrent edits
  status: Status;
  text: string; // cleaned display text, metadata stripped
  rawText: string; // untouched original line, for splicing/round-tripping
  dueDate?: string; // YYYY-MM-DD
  recurrence?: Recurrence;
  priority?: Priority;
  completedAt?: string; // YYYY-MM-DD HH:MM:SS
}

export interface ParsedTaskLine {
  status: Status;
  text: string;
  rawText: string;
  dueDate?: string;
  recurrence?: Recurrence;
  priority?: Priority;
  completedAt?: string;
}

/** Detects a GFM-style task checkbox line. Group 1: leading indent. Group 2: status char. Group 3: everything after the checkbox. */
export const TASK_LINE_RE = /^(\s*)-\s*\[([ x/])\]\s*(.*)$/;

const PRIORITY_EMOJI: Record<Priority, string> = { high: '🔺', medium: '🔼', low: '🔽' };
const PRIORITY_BY_EMOJI: Record<string, Priority> = { '🔺': 'high', '🔼': 'medium', '🔽': 'low' };

function statusFromChar(ch: string): Status {
  return ch === ' ' ? 'todo' : ch === '/' ? 'doing' : 'done';
}

function statusMarker(status: Status): string {
  return status === 'todo' ? ' ' : status === 'doing' ? '/' : 'x';
}

/** Classifies a `@repeat()` unit char (case-sensitive - `m` months, `M` minutes). */
function classifyRecurrenceUnit(amount: number, unit: string, raw: string): Recurrence {
  if (unit === 'y' || unit === 'w' || unit === 'd' || unit === 'm') {
    return { amount, unit: unit as RecurrenceUnit, supported: true };
  }
  return { amount, unit: unit as 'h' | 'M' | 'S', raw, supported: false };
}

/**
 * Parses a task's metadata out of the text following its checkbox marker.
 * Order of extraction mirrors the app's historical precedence (completion
 * timestamp, then `@`-notation before emoji before Org-mode for each of
 * due-date/recurrence) so old vaults with redundant/legacy markers keep
 * resolving the same way they always have.
 */
function extractMetadata(rawText: string): {
  text: string;
  dueDate?: string;
  recurrence?: Recurrence;
  priority?: Priority;
  completedAt?: string;
} {
  let text = rawText;
  let dueDate: string | undefined;
  let recurrence: Recurrence | undefined;
  let priority: Priority | undefined;
  let completedAt: string | undefined;

  // 1. Completion timestamp (✓ YYYY-MM-DD HH:MM:SS)
  const completeMatch = text.match(/✓\s*(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
  if (completeMatch) {
    completedAt = completeMatch[1];
    text = text.replace(completeMatch[0], '').trim();
  }

  // 2. Priority (new; order among high/medium/low doesn't matter - a line
  // should only ever carry one, but if more than one is present, the
  // highest-precedence marker checked first wins).
  for (const [emoji, level] of Object.entries(PRIORITY_BY_EMOJI) as [string, Priority][]) {
    if (text.includes(emoji)) {
      priority = level;
      text = text.split(emoji).join('').replace(/\s{2,}/g, ' ').trim();
      break;
    }
  }

  // 3. Recurrence: @repeat(N<unit>) (Logseq-import, read-only) before 🔁 (canonical)
  const repeatAtMatch = text.match(/@repeat\((\d+)([ymwdhMS])\)/);
  if (repeatAtMatch) {
    const amount = parseInt(repeatAtMatch[1], 10);
    recurrence = classifyRecurrenceUnit(amount, repeatAtMatch[2], repeatAtMatch[0]);
    text = text.replace(repeatAtMatch[0], '').trim();
  } else {
    const recurEmojiMatch = text.match(/🔁\s?\+(\d+)([dwmy])/i);
    if (recurEmojiMatch) {
      recurrence = {
        amount: parseInt(recurEmojiMatch[1], 10),
        unit: recurEmojiMatch[2].toLowerCase() as RecurrenceUnit,
        supported: true
      };
      text = text.replace(recurEmojiMatch[0], '').trim();
    }
  }

  // 4. Due date: @due() before 📅 (both canonical-ish/app-written historically)
  // before Org-mode DEADLINE: <...> (import-only).
  const dueAtMatch = text.match(/@due\((\d{4}-\d{2}-\d{2})\)/);
  if (dueAtMatch) {
    dueDate = dueAtMatch[1];
    text = text.replace(dueAtMatch[0], '').trim();
  } else {
    const dueEmojiMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    if (dueEmojiMatch) {
      dueDate = dueEmojiMatch[1];
      text = text.replace(dueEmojiMatch[0], '').trim();
    } else {
      const deadlineMatch = text.match(/DEADLINE:\s*<(\d{4}-\d{2}-\d{2})/i);
      if (deadlineMatch) {
        dueDate = deadlineMatch[1];
        // Deliberately not stripped from `text` - matches original behavior
        // (this branch never mutated text either) and keeps `SCHEDULED:`
        // (never parsed at all here) and `DEADLINE:` visually consistent:
        // both remain inert text, only the date value is surfaced.
      }
    }
  }

  return {
    text: text.replace(/\s{2,}/g, ' ').trim(),
    dueDate,
    recurrence,
    priority,
    completedAt
  };
}

/** Parses one full markdown line. Returns `null` if it isn't a task checkbox line. */
export function parseTaskLine(lineText: string): ParsedTaskLine | null {
  const match = TASK_LINE_RE.exec(lineText);
  if (!match) return null;
  const status = statusFromChar(match[2]);
  const meta = extractMetadata(match[3]);
  return { status, rawText: lineText, ...meta };
}

export interface TaskMetadataSpan {
  field: 'priority' | 'due' | 'recurrence' | 'completedAt';
  start: number;
  end: number;
}

/**
 * Finds the character ranges of each metadata token within a raw task line
 * (absolute offsets into `lineText`), for UI layers that need to replace
 * each token with a rich widget (a pill, an icon) rather than just knowing
 * its parsed value. Mirrors `extractMetadata`'s own precedence (so the span
 * found here is always the same occurrence `parseTaskLine` resolved), but
 * is presentation plumbing, not parsing - it does not strip or interpret
 * anything itself.
 */
export function findMetadataSpans(lineText: string): TaskMetadataSpan[] {
  const spans: TaskMetadataSpan[] = [];

  const completeMatch = /✓\s*\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/.exec(lineText);
  if (completeMatch) {
    spans.push({
      field: 'completedAt',
      start: completeMatch.index,
      end: completeMatch.index + completeMatch[0].length
    });
  }

  for (const emoji of Object.keys(PRIORITY_BY_EMOJI)) {
    const idx = lineText.indexOf(emoji);
    if (idx !== -1) {
      spans.push({ field: 'priority', start: idx, end: idx + emoji.length });
      break;
    }
  }

  const recurMatch =
    /@repeat\(\d+[ymwdhMS]\)/.exec(lineText) ?? /🔁\s?\+\d+[dwmy]/i.exec(lineText);
  if (recurMatch) {
    spans.push({
      field: 'recurrence',
      start: recurMatch.index,
      end: recurMatch.index + recurMatch[0].length
    });
  }

  const dueMatch =
    /@due\(\d{4}-\d{2}-\d{2}\)/.exec(lineText) ??
    /📅\s*\d{4}-\d{2}-\d{2}/.exec(lineText) ??
    /DEADLINE:\s*<\d{4}-\d{2}-\d{2}/i.exec(lineText);
  if (dueMatch) {
    spans.push({ field: 'due', start: dueMatch.index, end: dueMatch.index + dueMatch[0].length });
  }

  return spans.sort((a, b) => a.start - b.start);
}

/** Extracts every task from a whole file's content, in document order with 1-indexed line numbers. */
export function extractTasksFromContent(content: string, filename: string): Task[] {
  const tasks: Task[] = [];
  const re = /^(\s*)-\s*\[([ x/])\]\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const rawText = match[0];
    const parsed = parseTaskLine(rawText);
    if (!parsed) continue;
    const line = content.substring(0, match.index).split('\n').length;
    tasks.push({ file: filename, line, ...parsed });
  }
  return tasks;
}

export interface TaskMetadataInput {
  due?: string | null;
  recurrence?: { amount: number; unit: RecurrenceUnit } | null;
  priority?: Priority | null;
  completedAt?: string | null;
}

/** Builds the canonical trailing metadata suffix, e.g. "🔺 📅 2026-01-15 🔁 +1w ✓ 2026-01-15 09:00:00". */
export function serializeTaskMetadata(meta: TaskMetadataInput): string {
  const parts: string[] = [];
  if (meta.priority) parts.push(PRIORITY_EMOJI[meta.priority]);
  if (meta.due) parts.push(`📅 ${meta.due}`);
  if (meta.recurrence) parts.push(`🔁 +${meta.recurrence.amount}${meta.recurrence.unit}`);
  if (meta.completedAt) parts.push(`✓ ${meta.completedAt}`);
  return parts.join(' ');
}

/** Rebuilds a full task line from its clean text + status + metadata, preserving leading indent. */
export function serializeTaskLine(
  indent: string,
  status: Status,
  cleanText: string,
  meta: TaskMetadataInput = {}
): string {
  const suffix = serializeTaskMetadata(meta);
  const base = `${indent}- [${statusMarker(status)}] ${cleanText}`;
  return suffix ? `${base} ${suffix}` : base;
}

/** todo -> doing -> done -> todo. */
export function cycleStatus(status: Status): Status {
  return status === 'todo' ? 'doing' : status === 'doing' ? 'done' : 'todo';
}

function parseYMD(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split('-').map(Number);
  return [y, m, d];
}

/** Local noon avoids DST-boundary day-shift surprises from date math anchored at midnight. */
function toLocalNoon(dateStr: string): Date {
  const [y, m, d] = parseYMD(dateStr);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addIntervalToDateString(dateStr: string, amount: number, unit: RecurrenceUnit): string {
  const date = toLocalNoon(dateStr);
  switch (unit) {
    case 'd':
      date.setDate(date.getDate() + amount);
      break;
    case 'w':
      date.setDate(date.getDate() + amount * 7);
      break;
    case 'm':
      date.setMonth(date.getMonth() + amount);
      break;
    case 'y':
      date.setFullYear(date.getFullYear() + amount);
      break;
  }
  return formatLocalDate(date);
}

/** Today's date, local time, as YYYY-MM-DD - the app's one notion of "today" for task urgency. */
export function todayString(now: Date = new Date()): string {
  return formatLocalDate(now);
}

export function isPastDate(dateStr: string, today: string = todayString()): boolean {
  return dateStr < today;
}

export function isTodayDate(dateStr: string, today: string = todayString()): boolean {
  return dateStr === today;
}

export function isFutureDate(dateStr: string, today: string = todayString()): boolean {
  return dateStr > today;
}

/**
 * Computes the next occurrence of a recurring task, always advancing from
 * the previous due date (fixed-schedule semantics, matching the app's
 * existing behavior - not "N days after whenever it was actually
 * completed"). Returns `null` for an unsupported unit (h/M/S legacy
 * imports) - callers should treat that exactly like a non-recurring task.
 * Includes a catch-up clamp: if a task was completed late enough that the
 * naive next date is still today-or-earlier, keeps advancing until it's
 * strictly in the future, so a late completion never spawns an
 * already-overdue clone.
 */
export function computeNextOccurrence(
  dueDate: string,
  recurrence: Recurrence,
  opts: { today?: string } = {}
): string | null {
  if (!recurrence.supported) return null;
  const today = opts.today ?? todayString();

  let next = addIntervalToDateString(dueDate, recurrence.amount, recurrence.unit);
  let guard = 0;
  while (next <= today && guard < 10_000) {
    next = addIntervalToDateString(next, recurrence.amount, recurrence.unit);
    guard++;
  }
  return next;
}

/** `YYYY-MM-DD HH:MM:SS`, local time. */
export function getCurrentTimestamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/** Formats a completion timestamp for display, e.g. "Jan 12, 2:30 PM". */
export function formatTimestamp(timestampStr: string): string {
  const [dateStr, timeStr] = timestampStr.split(' ');
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  const date = new Date(year, month - 1, day, hours, minutes);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function metaFromParsed(parsed: ParsedTaskLine): TaskMetadataInput {
  return {
    due: parsed.dueDate,
    recurrence:
      parsed.recurrence && parsed.recurrence.supported
        ? { amount: parsed.recurrence.amount, unit: parsed.recurrence.unit }
        : undefined,
    priority: parsed.priority
  };
}

export interface RecurrenceAdvanceResult {
  completedLine: string;
  /** The freshly-inserted next occurrence, or `null` if the task isn't (usably) recurring. */
  nextLine: string | null;
}

/**
 * The one canonical "what happens to this raw line when its task is
 * completed" primitive - used by the editor's checkbox/keyboard toggle and
 * by the `complete_task` MCP tool alike, so their behavior can never drift
 * apart the way three independent implementations used to. Operates on raw
 * text only, so callers can splice the result directly into a live editor
 * buffer or a file on disk. The completed line retains its own due
 * date/recurrence/priority markers (full per-occurrence history, not a
 * single line whose date advances in place - see the redesign plan's
 * recurrence-model decision).
 */
export function buildRecurrenceAdvance(
  rawLineText: string,
  opts: { now?: Date } = {}
): RecurrenceAdvanceResult {
  const match = TASK_LINE_RE.exec(rawLineText);
  const parsed = parseTaskLine(rawLineText);
  if (!match || !parsed) {
    return { completedLine: rawLineText, nextLine: null };
  }

  const indent = match[1];
  const timestamp = getCurrentTimestamp(opts.now);
  const baseMeta = metaFromParsed(parsed);

  const completedLine = serializeTaskLine(indent, 'done', parsed.text, {
    ...baseMeta,
    completedAt: timestamp
  });

  let nextLine: string | null = null;
  if (parsed.recurrence?.supported && parsed.dueDate) {
    const nextDue = computeNextOccurrence(parsed.dueDate, parsed.recurrence, {
      today: opts.now ? todayString(opts.now) : undefined
    });
    if (nextDue) {
      nextLine = serializeTaskLine(indent, 'todo', parsed.text, { ...baseMeta, due: nextDue });
    }
  }

  return { completedLine, nextLine };
}

/**
 * Advances a task line's status by one step (todo -> doing -> done -> todo).
 * Completing a recurring task (supported recurrence + due date) delegates
 * to `buildRecurrenceAdvance` and returns two lines instead of one. This is
 * the single source of truth for "click the checkbox" / "Mod-Enter" - the
 * editor's job is only to dispatch the returned lines into its buffer.
 */
export function toggleTaskLine(rawLineText: string, opts: { now?: Date } = {}): string[] {
  const match = TASK_LINE_RE.exec(rawLineText);
  const parsed = parseTaskLine(rawLineText);
  if (!match || !parsed) return [rawLineText];

  const indent = match[1];
  const nextStatus = cycleStatus(parsed.status);
  const baseMeta = metaFromParsed(parsed);

  if (nextStatus === 'done') {
    if (parsed.recurrence?.supported && parsed.dueDate) {
      const { completedLine, nextLine } = buildRecurrenceAdvance(rawLineText, opts);
      return nextLine ? [completedLine, nextLine] : [completedLine];
    }
    return [
      serializeTaskLine(indent, 'done', parsed.text, {
        ...baseMeta,
        completedAt: getCurrentTimestamp(opts.now)
      })
    ];
  }

  // -> doing, or done -> todo: no completion timestamp either way.
  return [serializeTaskLine(indent, nextStatus, parsed.text, baseMeta)];
}

export interface FormatTaskLineOptions {
  text: string;
  due?: string;
  recurrence?: string; // e.g. "+1w"
  priority?: Priority;
  status?: 'todo' | 'doing';
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCE_RE = /^\+\d+[dwmy]$/i;

function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Builds one `- [ ] text 🔺 📅 due 🔁 recurrence` task line, validating date/recurrence syntax up front. */
export function formatTaskLine(opts: FormatTaskLineOptions): string {
  const { due, recurrence, priority, status } = opts;

  if (typeof opts.text !== 'string' || opts.text.trim() === '') {
    throw new InvalidArgumentError('text must be a non-empty string');
  }
  if (opts.text.includes('\n')) {
    throw new InvalidArgumentError('text must be a single line');
  }

  // Tolerate a caller that already included a checkbox marker.
  const text = opts.text.trim().replace(/^-?\s*\[[ x/]\]\s*/i, '');
  if (text === '') {
    throw new InvalidArgumentError('text must be a non-empty string');
  }
  if (/📅|🔁|🔺|🔼|🔽/.test(text)) {
    throw new InvalidArgumentError(
      'pass due/recurrence/priority as separate options, not embedded in text'
    );
  }

  if (due !== undefined && (!DUE_DATE_RE.test(due) || !isValidCalendarDate(due))) {
    throw new InvalidArgumentError(`invalid due date: ${due} (expected YYYY-MM-DD)`);
  }
  if (recurrence !== undefined && !RECURRENCE_RE.test(recurrence)) {
    throw new InvalidArgumentError(
      `invalid recurrence: ${recurrence} (expected e.g. +1d, +2w, +1m, +1y)`
    );
  }

  const recurrenceMatch = recurrence ? /^\+(\d+)([dwmy])$/i.exec(recurrence) : null;
  return serializeTaskLine(
    '',
    status === 'doing' ? 'doing' : 'todo',
    text,
    {
      due,
      priority,
      recurrence: recurrenceMatch
        ? { amount: parseInt(recurrenceMatch[1], 10), unit: recurrenceMatch[2].toLowerCase() as RecurrenceUnit }
        : undefined
    }
  );
}

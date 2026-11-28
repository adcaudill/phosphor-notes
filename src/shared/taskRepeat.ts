/**
 * Repeat rules for task files: an iCalendar RRULE subset, computed with the
 * `rrule` library. Dates are calendar dates (YYYY-MM-DD) with an optional
 * HH:MM time that's carried over unchanged; all date math is done on UTC
 * midnights so time zones and DST never shift a day.
 *
 * Supported rule parts: FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYDAY,
 * BYMONTHDAY, BYMONTH, BYSETPOS, WKST. The end of a series lives in the
 * task's `repeat.until` / `repeat.count`, not in the rule, so UNTIL and COUNT
 * are rejected here.
 */
import { RRule } from 'rrule';

const ALLOWED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'WKST'
]);
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

function ruleParts(rule: string): Map<string, string> | null {
  const parts = new Map<string, string>();
  for (const piece of rule.split(';')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) return null;
    const key = piece.slice(0, eq).trim().toUpperCase();
    const value = piece
      .slice(eq + 1)
      .trim()
      .toUpperCase();
    if (!ALLOWED_PARTS.has(key) || !value || parts.has(key)) return null;
    parts.set(key, value);
  }
  return parts;
}

/** True if `rule` is a supported RRULE body (no `RRULE:` prefix, no DTSTART/UNTIL/COUNT). */
export function isValidRepeatRule(rule: string): boolean {
  if (typeof rule !== 'string' || /[\r\n:]/.test(rule)) return false;
  const parts = ruleParts(rule);
  if (!parts || !FREQS.has(parts.get('FREQ') ?? '')) return false;
  const interval = parts.get('INTERVAL');
  if (interval !== undefined && !/^[1-9]\d{0,3}$/.test(interval)) return false;
  try {
    RRule.parseString(rule);
    return true;
  } catch {
    return false;
  }
}

function toUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Adds months, clamping to the month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const monthIndex = total % 12;
  const day = Math.min(d, daysInMonth(year, monthIndex));
  return fromUtc(new Date(Date.UTC(year, monthIndex, day)));
}

export function addDays(date: string, days: number): string {
  const dt = toUtc(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fromUtc(dt);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/**
 * "Monthly on day N", clamped: in months without day N (e.g. the 31st in
 * April) it falls on the month's last day instead of skipping the month,
 * which is what plain BYMONTHDAY=N would do.
 */
export function monthlyOnDayRule(day: number, interval = 1): string {
  const every = interval > 1 ? `;INTERVAL=${interval}` : '';
  if (day <= 28) return `FREQ=MONTHLY${every};BYMONTHDAY=${day}`;
  const days: number[] = [];
  for (let d = 28; d <= day; d++) days.push(d);
  return `FREQ=MONTHLY${every};BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
}

export type IntervalUnit = 'd' | 'w' | 'm' | 'y';

/** A rule for "every N days/weeks/months/years", anchored on `anchorDate`'s weekday or day of month. */
export function intervalRule(amount: number, unit: IntervalUnit, anchorDate: string): string {
  const every = amount > 1 ? `;INTERVAL=${amount}` : '';
  switch (unit) {
    case 'd':
      return `FREQ=DAILY${every}`;
    case 'w':
      return `FREQ=WEEKLY${every}`;
    case 'm':
      return monthlyOnDayRule(Number(anchorDate.slice(8, 10)), amount);
    case 'y':
      return `FREQ=YEARLY${every}`;
  }
}

export interface RepeatSpec {
  rule: string;
  from: 'due' | 'completion';
  until?: string;
  count?: number;
}

export interface NextOccurrence {
  /** The next due value (same time-of-day suffix as the current one), or null when the series has ended. */
  due: string | null;
  /** The remaining-occurrence count to store next, when the series has a count. */
  count?: number;
}

function addByFreq(date: string, rule: string): string {
  const parts = ruleParts(rule) ?? new Map<string, string>();
  const n = Number(parts.get('INTERVAL') ?? '1');
  switch (parts.get('FREQ')) {
    case 'DAILY':
      return addDays(date, n);
    case 'WEEKLY':
      return addDays(date, 7 * n);
    case 'MONTHLY':
      return addMonthsClamped(date, n);
    default:
      return addMonthsClamped(date, 12 * n);
  }
}

/**
 * The next due date after completing (or skipping) the current occurrence.
 *
 * - `from: 'due'` - the next occurrence of the rule after the current due
 *   date. If that's still today or earlier (it was completed late), it keeps
 *   going to the first occurrence after today, so a late completion never
 *   leaves the task already overdue.
 * - `from: 'completion'` - FREQ x INTERVAL after `completedOn` (day rules
 *   don't apply: "every 3 days after done").
 *
 * Returns `due: null` once the series has ended (past `until`, or the last
 * of `count`).
 */
export function nextOccurrence(
  repeat: RepeatSpec,
  currentDue: string,
  opts: { completedOn: string; today: string }
): NextOccurrence {
  if (repeat.count !== undefined && repeat.count <= 1) return { due: null, count: 0 };

  const base = currentDue.slice(0, 10);
  const time = currentDue.slice(10); // '' or 'THH:MM'
  let next: string;

  if (repeat.from === 'completion') {
    next = addByFreq(opts.completedOn, repeat.rule);
  } else {
    const rule = new RRule({ ...RRule.parseString(repeat.rule), dtstart: toUtc(base) });
    let cursor = rule.after(toUtc(base), false);
    let guard = 0;
    while (cursor && fromUtc(cursor) <= opts.today && guard < 10_000) {
      cursor = rule.after(cursor, false);
      guard++;
    }
    if (!cursor) return { due: null };
    next = fromUtc(cursor);
  }

  if (repeat.until && next > repeat.until) return { due: null };
  return {
    due: next + time,
    ...(repeat.count !== undefined ? { count: repeat.count - 1 } : {})
  };
}

/** The next few occurrences on or after `from`, for previews ("Dec 1, Jan 1, Feb 1"). */
export function upcomingOccurrences(rule: string, from: string, limit = 3): string[] {
  if (!isValidRepeatRule(rule)) return [];
  const rr = new RRule({ ...RRule.parseString(rule), dtstart: toUtc(from) });
  return rr.all((_d, i) => i < limit).map(fromUtc);
}

/**
 * Task parser for extracting metadata (dates, recurrence) from task text
 */

export interface TaskMetadata {
  dueDate: Date | null;
  scheduledDate: Date | null;
  recurrence: string | null; // e.g., "+1w"
  completedAt: string | null; // ISO datetime string
  cleanText: string; // Text without metadata
}

/**
 * Parse task metadata from raw task text
 * Supports both emoji style (📅 2026-01-15 🔁 +1w) and Org-mode style
 */
export function parseTaskMetadata(rawText: string): TaskMetadata {
  let text = rawText;
  let dueDate: Date | null = null;
  let scheduledDate: Date | null = null;
  let recurrence: string | null = null;
  let completedAt: string | null = null;

  // 1. Extract Completion Timestamp (✓ 2026-01-12 14:30:45)
  const completeMatch = text.match(/✓\s*(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
  if (completeMatch) {
    completedAt = completeMatch[1];
    text = text.replace(completeMatch[0], '').trim();
  }

  // 2. Extract Recurrence (🔁 +1d/w/m/y)
  const recurMatch = text.match(/🔁\s?(\+\d+[dwmy])/i);
  if (recurMatch) {
    recurrence = recurMatch[1].toLowerCase();
    text = text.replace(recurMatch[0], '').trim();
  }

  // 3. Extract Due Date (📅 YYYY-MM-DD)
  const dateMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const dateStr = dateMatch[1];
    dueDate = parseDate(dateStr);
    text = text.replace(dateMatch[0], '').trim();
  }

  // 4. Support Org-Mode SCHEDULED style
  if (!scheduledDate) {
    const scheduledMatch = text.match(/SCHEDULED:\s*<(\d{4}-\d{2}-\d{2})/i);
    if (scheduledMatch) {
      scheduledDate = parseDate(scheduledMatch[1]);
    }
  }

  // 5. Support Org-Mode DEADLINE style
  if (!dueDate) {
    const deadlineMatch = text.match(/DEADLINE:\s*<(\d{4}-\d{2}-\d{2})/i);
    if (deadlineMatch) {
      dueDate = parseDate(deadlineMatch[1]);
    }
  }

  return { dueDate, scheduledDate, recurrence, completedAt, cleanText: text };
}

/**
 * Parse a date string in YYYY-MM-DD format
 */
function parseDate(dateStr: string): Date {
  const date = new Date(dateStr + 'T00:00:00Z');
  return date;
}

/**
 * Format a date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a date is in the past
 */
export function isPast(date: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

/**
 * Check if a date is today
 */
export function isToday(date: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateNorm = new Date(date);
  dateNorm.setHours(0, 0, 0, 0);
  return dateNorm.getTime() === today.getTime();
}

/**
 * Check if a date is in the future
 */
export function isFuture(date: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

/**
 * Add days to a date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Add weeks to a date
 */
export function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

/**
 * Add months to a date
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Add years to a date
 */
export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

/**
 * Parse recurrence interval and add to date
 * e.g., "+1w" -> 1 week, "+2d" -> 2 days
 */
export function addInterval(date: Date, interval: string): Date {
  const match = interval.match(/\+(\d+)([dwmy])/i);
  if (!match) return date;

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'd':
      return addDays(date, amount);
    case 'w':
      return addWeeks(date, amount);
    case 'm':
      return addMonths(date, amount);
    case 'y':
      return addYears(date, amount);
    default:
      return date;
  }
}

/**
 * Get current timestamp in YYYY-MM-DD HH:MM:SS format
 */
export function getCurrentTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format a timestamp for display (e.g., "Jan 12, 2:30 PM")
 */
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

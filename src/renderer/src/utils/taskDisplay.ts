/**
 * Presentational helpers shared between the in-editor metadata pills
 * (taskMetadataWidgets.ts, rendered as raw CM6 widget DOM) and the Tasks
 * view (TasksView.tsx, rendered as React JSX) - so both surfaces describe
 * a task's priority/due date/recurrence identically instead of drifting.
 * Pure display logic only; parsing/serialization stays in shared/tasks.ts.
 */
import { isPastDate, isTodayDate, type Priority } from '../../../shared/tasks';
import { daysBetween } from '../../../shared/taskRepeat';

export const PRIORITY_ICON: Record<Priority, string> = {
  high: 'keyboard_double_arrow_up',
  medium: 'remove',
  low: 'keyboard_double_arrow_down'
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority'
};

const UNIT_NAME: Record<string, string> = { d: 'day', w: 'week', m: 'month', y: 'year' };

export function dueDateLabel(dateStr: string): {
  text: string;
  status: 'overdue' | 'today' | 'future';
} {
  if (isTodayDate(dateStr)) return { text: 'Today', status: 'today' };
  if (isPastDate(dateStr)) return { text: dateStr, status: 'overdue' };
  return { text: dateStr, status: 'future' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A due date as people say it: "Today", "Tomorrow", "Yesterday", a weekday
 * within the coming week ("Fri"), otherwise "Dec 4" (with the year when it
 * isn't this year), plus the time for a "due at" value. `today` is
 * YYYY-MM-DD.
 */
export function friendlyDueLabel(
  due: string,
  today: string
): { text: string; status: 'overdue' | 'today' | 'future' } {
  const date = due.slice(0, 10);
  const time = due.length > 10 ? due.slice(11, 16) : '';
  const diff = daysBetween(today, date);
  const status = diff < 0 ? 'overdue' : diff === 0 ? 'today' : 'future';
  const [y, m, d] = date.split('-').map(Number);
  let text: string;
  if (diff === 0) text = 'Today';
  else if (diff === 1) text = 'Tomorrow';
  else if (diff === -1) text = 'Yesterday';
  else if (diff > 1 && diff < 7) text = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  else text = `${MONTHS[m - 1]} ${d}${String(y) === today.slice(0, 4) ? '' : `, ${y}`}`;
  return { text: time ? `${text} ${time}` : text, status };
}

export function recurrenceLabel(amount: number, unit: string, supported: boolean): string {
  if (!supported) return `Repeats (legacy: ${amount}${unit})`;
  if (amount === 1) {
    return unit === 'd' ? 'Daily' : unit === 'w' ? 'Weekly' : unit === 'm' ? 'Monthly' : 'Yearly';
  }
  const name = UNIT_NAME[unit] ?? unit;
  return `Every ${amount} ${name}s`;
}

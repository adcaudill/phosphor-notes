/**
 * Presentational helpers shared between the in-editor metadata pills
 * (taskMetadataWidgets.ts, rendered as raw CM6 widget DOM) and the Tasks
 * view (TasksView.tsx, rendered as React JSX) - so both surfaces describe
 * a task's priority/due date/recurrence identically instead of drifting.
 * Pure display logic only; parsing/serialization stays in shared/tasks.ts.
 */
import { isPastDate, isTodayDate, type Priority } from '../../../shared/tasks';

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

export function recurrenceLabel(amount: number, unit: string, supported: boolean): string {
  if (!supported) return `Repeats (legacy: ${amount}${unit})`;
  if (amount === 1) {
    return unit === 'd' ? 'Daily' : unit === 'w' ? 'Weekly' : unit === 'm' ? 'Monthly' : 'Yearly';
  }
  const name = UNIT_NAME[unit] ?? unit;
  return `Every ${amount} ${name}s`;
}

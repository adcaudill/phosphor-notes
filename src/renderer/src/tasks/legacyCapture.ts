/**
 * Converting an inline checkbox task (`- [ ] text 📅 ... 🔁 ... 🔺`) into a
 * task file: its metadata, written as the plain-language words the task
 * capture parser reads back to the same fields - so the capture field can be
 * pre-filled and the person sees exactly what will be created.
 */
import type { ParsedTaskLine } from '../../../shared/tasks';

const RECURRENCE_WORDS: Record<string, [string, string]> = {
  d: ['day', 'days'],
  w: ['week', 'weeks'],
  m: ['month', 'months'],
  y: ['year', 'years']
};

export function legacyTaskAsCaptureText(parsed: ParsedTaskLine): string {
  const parts = [parsed.text];
  if (parsed.dueDate) parts.push(`due ${parsed.dueDate}`);
  if (parsed.recurrence?.supported) {
    const [one, many] = RECURRENCE_WORDS[parsed.recurrence.unit];
    parts.push(
      parsed.recurrence.amount === 1 ? `every ${one}` : `every ${parsed.recurrence.amount} ${many}`
    );
  }
  if (parsed.priority) parts.push(`!${parsed.priority === 'medium' ? 'med' : parsed.priority}`);
  return parts.join(' ');
}

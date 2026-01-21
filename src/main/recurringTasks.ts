/**
 * Recurrence handler for task completion
 * When a recurring task is marked done, duplicate it with updated date
 */

/**
 * Simple task metadata parser (duplicated for main process)
 */
interface TaskMetadata {
  dueDate: Date | null;
  recurrence: string | null;
  cleanText: string;
}

function parseTaskMetadata(rawText: string): TaskMetadata {
  let text = rawText;
  let dueDate: Date | null = null;
  let recurrence: string | null = null;

  const recurMatch = text.match(/🔁\s?(\+\d+[dwmy])/i);
  if (recurMatch) {
    recurrence = recurMatch[1].toLowerCase();
    text = text.replace(recurMatch[0], '').trim();
  }

  const dateMatch = text.match(/📅\s?(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const dateStr = dateMatch[1];
    dueDate = new Date(dateStr + 'T00:00:00Z');
    text = text.replace(dateMatch[0], '').trim();
  }

  return { dueDate, recurrence, cleanText: text };
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addInterval(date: Date, interval: string): Date {
  const match = interval.match(/\+(\d+)([dwmy])/i);
  if (!match) return date;

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  const result = new Date(date);
  switch (unit) {
    case 'd':
      result.setUTCDate(result.getUTCDate() + amount);
      break;
    case 'w':
      result.setUTCDate(result.getUTCDate() + amount * 7);
      break;
    case 'm':
      result.setUTCMonth(result.getUTCMonth() + amount);
      break;
    case 'y':
      result.setUTCFullYear(result.getUTCFullYear() + amount);
      break;
  }
  return result;
}

/**
 * Handle a recurring task completion
 * Returns the replacement line content (with checkbox toggled to [x])
 * and optionally a new line to insert below it
 */
export function handleRecurringTask(lineContent: string): {
  currentLine: string;
  nextLine?: string;
} {
  const metadata = parseTaskMetadata(lineContent);

  if (!metadata.recurrence || !metadata.dueDate) {
    const toggledLine = lineContent.replace(/\[[ x/]\]/, '[x]');
    return { currentLine: toggledLine };
  }

  const nextDate = addInterval(metadata.dueDate, metadata.recurrence);
  const nextDateStr = formatDate(nextDate);
  const currentDateStr = formatDate(metadata.dueDate);

  const currentLine = lineContent.replace(/\[[ x/]\]/, '[x]');

  const nextLine = lineContent.replace(/\[[ x/]\]/, '[ ]').replace(currentDateStr, nextDateStr);

  return { currentLine, nextLine };
}

/**
 * Check if a task line is recurring
 */
export function isRecurringTask(lineContent: string): boolean {
  const metadata = parseTaskMetadata(lineContent);
  return !!metadata.recurrence && !!metadata.dueDate;
}

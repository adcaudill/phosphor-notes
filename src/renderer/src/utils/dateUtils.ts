/**
 * Format a Date object to ISO 8601 date string (YYYY-MM-DD)
 */
export function getDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Get today's date as ISO 8601 string
 */
export function getTodayString(): string {
  return getDateString(new Date());
}

/**
 * Get a date string for a relative offset (in days)
 * @param offset - Number of days from today (positive or negative)
 */
export function getRelativeDateString(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return getDateString(date);
}

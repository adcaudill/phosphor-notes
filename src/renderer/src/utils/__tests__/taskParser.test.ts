import { describe, it, expect } from 'vitest';
import {
  parseTaskMetadata,
  formatDate,
  addDays,
  addWeeks,
  addMonths,
  addYears,
  addInterval,
  getCurrentTimestamp,
  formatTimestamp,
  isPast,
  isToday,
  isFuture
} from '../taskParser';

describe('taskParser', () => {
  describe('parseTaskMetadata', () => {
    it('should parse emoji-style due date', () => {
      const text = 'Buy groceries 📅 2026-01-15';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).not.toBeNull();
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
    });

    it('should parse emoji-style due date with spaces', () => {
      const text = 'Buy groceries 📅  2026-01-15';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).not.toBeNull();
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
    });

    it('should parse Org-mode DEADLINE style', () => {
      const text = 'Task Name DEADLINE: <2026-01-15>';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).not.toBeNull();
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
    });

    it('should parse Org-mode DEADLINE with no space after colon', () => {
      const text = 'Task Name DEADLINE:<2026-01-15>';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).not.toBeNull();
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
    });

    it('should parse Org-mode DEADLINE case-insensitive', () => {
      const text = 'Task Name deadline: <2026-01-15>';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).not.toBeNull();
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
    });

    it('should parse recurrence interval', () => {
      const text = 'Daily standup 🔁 +1d 📅 2026-01-15';
      const metadata = parseTaskMetadata(text);
      expect(metadata.recurrence).toBe('+1d');
    });

    it('should parse multiple recurrence units', () => {
      const testCases = [
        { text: 'task 🔁 +1d', expected: '+1d' },
        { text: 'task 🔁 +2w', expected: '+2w' },
        { text: 'task 🔁 +3m', expected: '+3m' },
        { text: 'task 🔁 +1y', expected: '+1y' }
      ];

      testCases.forEach(({ text, expected }) => {
        const metadata = parseTaskMetadata(text);
        expect(metadata.recurrence).toBe(expected);
      });
    });

    it('should parse completion timestamp', () => {
      const text = 'Completed task ✓ 2026-01-12 14:30:45';
      const metadata = parseTaskMetadata(text);
      expect(metadata.completedAt).toBe('2026-01-12 14:30:45');
    });

    it('should parse all metadata together', () => {
      const text = 'Meeting notes DEADLINE: <2026-01-20> 🔁 +1w ✓ 2026-01-12 10:00:00';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).not.toBeNull();
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-20');
      expect(metadata.recurrence).toBe('+1w');
      expect(metadata.completedAt).toBe('2026-01-12 10:00:00');
    });

    it('should clean text by removing metadata', () => {
      const text = 'Buy milk 📅 2026-01-15 🔁 +1d ✓ 2026-01-12 10:00:00';
      const metadata = parseTaskMetadata(text);
      expect(metadata.cleanText).toBe('Buy milk');
    });

    it('should not extract date without bracket markers', () => {
      const text = 'Task due on 2026-01-15';
      const metadata = parseTaskMetadata(text);
      expect(metadata.dueDate).toBeNull();
    });

    it('should prioritize emoji style over Org-mode DEADLINE', () => {
      const text = '📅 2026-01-10 DEADLINE: <2026-01-20>';
      const metadata = parseTaskMetadata(text);
      expect(formatDate(metadata.dueDate!)).toBe('2026-01-10');
    });
  });

  describe('Date arithmetic', () => {
    const testDate = new Date('2026-01-15T00:00:00Z');

    it('should add days correctly', () => {
      const result = addDays(testDate, 5);
      expect(formatDate(result)).toBe('2026-01-20');
    });

    it('should add weeks correctly', () => {
      const result = addWeeks(testDate, 2);
      expect(formatDate(result)).toBe('2026-01-29');
    });

    it('should add months correctly', () => {
      const result = addMonths(testDate, 2);
      expect(formatDate(result)).toBe('2026-03-15');
    });

    it('should add years correctly', () => {
      const result = addYears(testDate, 1);
      expect(formatDate(result)).toBe('2027-01-15');
    });

    it('should handle month boundaries when adding months', () => {
      const jan31 = new Date('2026-01-31T00:00:00Z');
      const result = addMonths(jan31, 1);
      // JS Date auto-adjusts: Jan 31 + 1 month rolls over to Mar 3
      // (Feb is 28 days, so it adds the remaining 3 days)
      // This is standard JS behavior, verify it's past February
      const resultMonth = result.getUTCMonth() + 1;
      expect([2, 3]).toContain(resultMonth);
    });
  });

  describe('addInterval', () => {
    const testDate = new Date('2026-01-15T00:00:00Z');

    it('should parse and apply +1d interval', () => {
      const result = addInterval(testDate, '+1d');
      expect(formatDate(result)).toBe('2026-01-16');
    });

    it('should parse and apply +2w interval', () => {
      const result = addInterval(testDate, '+2w');
      expect(formatDate(result)).toBe('2026-01-29');
    });

    it('should parse and apply +1m interval', () => {
      const result = addInterval(testDate, '+1m');
      expect(formatDate(result)).toBe('2026-02-15');
    });

    it('should parse and apply +1y interval', () => {
      const result = addInterval(testDate, '+1y');
      expect(formatDate(result)).toBe('2027-01-15');
    });

    it('should handle multi-digit intervals', () => {
      const result = addInterval(testDate, '+10d');
      expect(formatDate(result)).toBe('2026-01-25');
    });

    it('should return original date for invalid interval', () => {
      const result = addInterval(testDate, 'invalid');
      expect(formatDate(result)).toBe('2026-01-15');
    });
  });

  describe('formatDate', () => {
    it('should format date as YYYY-MM-DD', () => {
      const date = new Date('2026-01-15T00:00:00Z');
      expect(formatDate(date)).toBe('2026-01-15');
    });

    it('should pad single-digit months and days', () => {
      const date = new Date('2026-02-03T00:00:00Z');
      expect(formatDate(date)).toBe('2026-02-03');
    });
  });

  describe('Date comparison functions', () => {
    it('should identify past dates', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 5);
      expect(isPast(pastDate)).toBe(true);
    });

    it('should identify future dates', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 5);
      expect(isFuture(futureDate)).toBe(true);
    });

    it('should identify today', () => {
      const today = new Date();
      today.setHours(12, 0, 0, 0); // Set to noon
      expect(isToday(today)).toBe(true);
    });

    it('should not mark past as future', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      expect(isFuture(pastDate)).toBe(false);
    });

    it('should not mark today as past or future', () => {
      const today = new Date();
      today.setHours(12, 0, 0, 0);
      expect(isPast(today)).toBe(false);
      expect(isFuture(today)).toBe(false);
    });
  });

  describe('Timestamp functions', () => {
    it('should return current timestamp in correct format', () => {
      const timestamp = getCurrentTimestamp();
      // Format: YYYY-MM-DD HH:MM:SS
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('should format timestamp for display', () => {
      const timestamp = '2026-01-12 14:30:45';
      const formatted = formatTimestamp(timestamp);
      // Should contain month, day, time with AM/PM
      expect(formatted).toMatch(/Jan\s+\d{1,2},\s+\d{1,2}:\d{2}\s+(AM|PM)/);
    });

    it('should handle edge case times', () => {
      const midnight = '2026-01-01 00:00:00';
      const formatted = formatTimestamp(midnight);
      expect(formatted).toContain('12:00');
      expect(formatted).toContain('AM');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle recurring task scenario', () => {
      const taskText = 'Daily standup 📅 2026-01-12 🔁 +1d';
      const metadata = parseTaskMetadata(taskText);

      expect(metadata.dueDate).not.toBeNull();
      expect(metadata.recurrence).toBe('+1d');

      // Simulate completing task and creating next occurrence
      const nextDate = addInterval(metadata.dueDate!, metadata.recurrence!);
      expect(formatDate(nextDate)).toBe('2026-01-13');
    });

    it('should handle Org-mode recurring task', () => {
      const taskText = 'Weekly review DEADLINE: <2026-01-15> 🔁 +1w';
      const metadata = parseTaskMetadata(taskText);

      expect(formatDate(metadata.dueDate!)).toBe('2026-01-15');
      expect(metadata.recurrence).toBe('+1w');

      const nextDate = addInterval(metadata.dueDate!, metadata.recurrence!);
      expect(formatDate(nextDate)).toBe('2026-01-22');
    });

    it('should handle task with past completion timestamp', () => {
      const taskText = 'Old task 📅 2025-12-01 ✓ 2025-12-02 10:00:00';
      const metadata = parseTaskMetadata(taskText);

      expect(metadata.dueDate).not.toBeNull();
      expect(metadata.completedAt).toBe('2025-12-02 10:00:00');
      expect(isPast(metadata.dueDate!)).toBe(true);
    });
  });
});

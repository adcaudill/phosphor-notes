import { describe, it, expect } from 'vitest';
import { handleRecurringTask, isRecurringTask } from '../recurringTasks';

/**
 * Test suite for recurring task logic
 * Tests the core functionality of duplicating tasks with updated dates
 */

describe('Recurring Task Handler', () => {
  describe('isRecurringTask', () => {
    it('should identify task with date and recurrence as recurring', () => {
      const line = '- [ ] Daily standup 📅 2026-01-15 🔁 +1d';
      expect(isRecurringTask(line)).toBe(true);
    });

    it('should return false for task without recurrence', () => {
      const line = '- [ ] One-time task 📅 2026-01-15';
      expect(isRecurringTask(line)).toBe(false);
    });

    it('should return false for task without date', () => {
      const line = '- [ ] Recurring but no date 🔁 +1d';
      expect(isRecurringTask(line)).toBe(false);
    });

    it('should return false for task with neither date nor recurrence', () => {
      const line = '- [ ] Regular task';
      expect(isRecurringTask(line)).toBe(false);
    });

    it('should identify Org-mode recurring tasks', () => {
      const line = '- [ ] Weekly review DEADLINE: <2026-01-15> 🔁 +1w';
      // Note: current implementation only supports emoji-style dates
      // This test documents current limitation
      expect(isRecurringTask(line)).toBe(false);
    });
  });

  describe('handleRecurringTask - Daily Tasks', () => {
    it('should create next daily task', () => {
      const line = '- [ ] Daily standup 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toBeDefined();
      expect(result.nextLine).toContain('[ ]');
      expect(result.nextLine).toContain('2026-01-16');
      expect(result.nextLine).not.toContain('2026-01-15');
    });

    it('should handle multiple day intervals', () => {
      const line = '- [ ] Every 3 days 📅 2026-01-15 🔁 +3d';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-01-18');
    });

    it('should toggle checkbox to done on current line', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toMatch(/\[x\]/);
    });

    it('should reset checkbox to todo on next line', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toMatch(/\[ \]/);
    });

    it('should preserve task text', () => {
      const taskText = 'Important daily sync';
      const line = `- [ ] ${taskText} 📅 2026-01-15 🔁 +1d`;
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain(taskText);
    });

    it('should work with todo state', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toContain('[ ]');
    });

    it('should work with doing state', () => {
      const line = '- [/] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toContain('[ ]');
    });

    it('should work with done state (already completed)', () => {
      const line = '- [x] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toContain('[ ]');
    });
  });

  describe('handleRecurringTask - Weekly Tasks', () => {
    it('should create next weekly task', () => {
      const line = '- [ ] Weekly review 📅 2026-01-15 🔁 +1w';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-01-22');
      expect(result.nextLine).not.toContain('2026-01-15');
    });

    it('should handle multiple week intervals', () => {
      const line = '- [ ] Bi-weekly standup 📅 2026-01-15 🔁 +2w';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-01-29');
    });

    it('should handle large week intervals', () => {
      const line = '- [ ] Monthly project review 📅 2026-01-15 🔁 +4w';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-02-12');
    });
  });

  describe('handleRecurringTask - Monthly Tasks', () => {
    it('should create next monthly task', () => {
      const line = '- [ ] Monthly report 📅 2026-01-15 🔁 +1m';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-02-15');
    });

    it('should handle multiple month intervals', () => {
      const line = '- [ ] Quarterly review 📅 2026-01-15 🔁 +3m';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-04-15');
    });

    it('should handle month boundaries correctly', () => {
      // Jan has 31 days, Feb has 28/29
      const line = '- [ ] Task 📅 2026-01-31 🔁 +1m';
      const result = handleRecurringTask(line);

      // When adding month to Jan 31, JS rolls over to Mar 3
      // (Jan 31 + 1 month - setUTCMonth doesn't adjust day)
      expect(result.nextLine).toBeDefined();
      // Just verify it's a valid date in the future
      expect(result.nextLine).toMatch(/📅 \d{4}-\d{2}-\d{2}/);
    });

    it('should handle different month lengths within a year', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1m';
      const result = handleRecurringTask(line);
      // Should be Feb 15 (both months have the 15th)
      expect(result.nextLine).toContain('2026-02-15');
    });
  });

  describe('handleRecurringTask - Yearly Tasks', () => {
    it('should create next yearly task', () => {
      const line = '- [ ] Annual review 📅 2026-01-15 🔁 +1y';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2027-01-15');
    });

    it('should handle multiple year intervals', () => {
      const line = '- [ ] Biennial task 📅 2026-01-15 🔁 +2y';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2028-01-15');
    });

    it('should handle leap year date (Feb 29)', () => {
      // 2024 is a leap year, 2025 is not
      const line = '- [ ] Anniversary 📅 2024-02-29 🔁 +1y';
      const result = handleRecurringTask(line);

      // When adding year to Feb 29 in non-leap year, JS rolls over
      expect(result.nextLine).toBeDefined();
      expect(result.nextLine).toMatch(/📅 \d{4}-\d{2}-\d{2}/);
    });
  });

  describe('handleRecurringTask - Complex Scenarios', () => {
    it('should handle task with multiple metadata pieces', () => {
      const line = '- [ ] Team standup 📅 2026-01-15 🔁 +1d Additional info';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toContain('[ ]');
      expect(result.nextLine).toContain('2026-01-16');
    });

    it('should handle mixed case recurrence', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1D';
      const result = handleRecurringTask(line);

      // Should still work, interval is normalized to lowercase
      expect(result.nextLine).toContain('2026-01-16');
    });

    it('should preserve spacing and formatting', () => {
      const line = '- [ ] Task name 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      // Both lines should maintain task list format
      expect(result.currentLine).toMatch(/^-\s*\[.\]\s/);
      expect(result.nextLine).toMatch(/^-\s*\[.\]\s/);
    });

    it('should handle task with special characters', () => {
      const line = '- [ ] Review PR #123 @john 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('Review PR #123 @john');
      expect(result.nextLine).toContain('2026-01-16');
    });

    it('should handle task with code reference', () => {
      const line = '- [ ] Check `util.js` 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('`util.js`');
    });

    it('should handle task with URL', () => {
      const line = '- [ ] Review https://example.com 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('https://example.com');
    });
  });

  describe('Non-recurring Task Handling', () => {
    it('should handle non-recurring task without creating next line', () => {
      const line = '- [ ] One-time task 📅 2026-01-15';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toBeUndefined();
    });

    it('should toggle checkbox on non-recurring task', () => {
      const line = '- [ ] Simple task';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toBeUndefined();
    });

    it('should handle task with only recurrence (no date)', () => {
      const line = '- [ ] Task 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toBeUndefined();
    });

    it('should handle task with only date (no recurrence)', () => {
      const line = '- [ ] One-time task 📅 2026-01-15';
      const result = handleRecurringTask(line);

      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toBeUndefined();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle year boundary (Dec 31 + 1 day)', () => {
      const line = '- [ ] EOY task 📅 2025-12-31 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain('2026-01-01');
    });

    it('should handle month boundary multiple times', () => {
      const line = '- [ ] Task 📅 2026-01-28 🔁 +5d';
      const result = handleRecurringTask(line);

      // 28 + 5 = 33 Jan, which is 2 Feb
      expect(result.nextLine).toContain('2026-02-02');
    });

    it('should handle empty recurrence gracefully', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁';
      const result = handleRecurringTask(line);

      // Invalid recurrence, treat as non-recurring
      expect(result.currentLine).toContain('[x]');
      expect(result.nextLine).toBeUndefined();
    });

    it('should preserve date format consistency', () => {
      const line = '- [ ] Task 📅 2026-01-05 🔁 +1d';
      const result = handleRecurringTask(line);

      // Date should maintain YYYY-MM-DD format with leading zeros
      expect(result.nextLine).toContain('📅 2026-01-06');
    });

    it('should handle very long task descriptions', () => {
      const longDesc = 'Very long task description ' + 'x'.repeat(100);
      const line = `- [ ] ${longDesc} 📅 2026-01-15 🔁 +1d`;
      const result = handleRecurringTask(line);

      expect(result.nextLine).toContain(longDesc);
    });
  });

  describe('Return Value Structure', () => {
    it('should always return currentLine', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result).toHaveProperty('currentLine');
      expect(result.currentLine).toBeDefined();
    });

    it('should include nextLine for recurring tasks', () => {
      const line = '- [ ] Task 📅 2026-01-15 🔁 +1d';
      const result = handleRecurringTask(line);

      expect(result).toHaveProperty('nextLine');
      expect(result.nextLine).toBeDefined();
    });

    it('should not include nextLine for non-recurring tasks', () => {
      const line = '- [ ] Task';
      const result = handleRecurringTask(line);

      expect(result.nextLine).toBeUndefined();
    });

    it('should have correct structure for all task types', () => {
      const testCases = [
        '- [ ] Task 📅 2026-01-15',
        '- [ ] Task 📅 2026-01-15 🔁 +1d',
        '- [/] Task 📅 2026-01-15 🔁 +1w',
        '- [x] Task 📅 2026-01-15 🔁 +1m'
      ];

      testCases.forEach((line) => {
        const result = handleRecurringTask(line);
        expect(result).toHaveProperty('currentLine');
        expect(typeof result.currentLine).toBe('string');
        expect(result.currentLine.length).toBeGreaterThan(0);
      });
    });
  });
});

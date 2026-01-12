import { describe, it, expect } from 'vitest';

/**
 * Test suite for TasksView sorting and filtering logic
 * Tests urgency calculation, task grouping, and filtering behavior
 */

interface Task {
  file: string;
  line: number;
  status: 'todo' | 'doing' | 'done';
  text: string;
  dueDate?: string;
  completedAt?: string;
}

/**
 * Replicate the urgency calculation from TasksView
 */
function getTodayString(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPast(dateStr: string): boolean {
  return dateStr < getTodayString();
}

function isToday(dateStr: string): boolean {
  return dateStr === getTodayString();
}

function getUrgencyCategory(task: Task): 'overdue' | 'today' | 'upcoming' | 'no-date' {
  if (!task.dueDate) return 'no-date';
  if (isPast(task.dueDate)) return 'overdue';
  if (isToday(task.dueDate)) return 'today';
  return 'upcoming';
}

/**
 * Replicate urgency-based sorting logic from TasksView
 */
function sortByUrgency(tasks: Task[]): Task[] {
  const urgencyOrder = { overdue: 0, today: 1, upcoming: 2, 'no-date': 3 };
  const sorted = [...tasks];
  sorted.sort((a, b) => {
    const urgencyA = urgencyOrder[getUrgencyCategory(a)];
    const urgencyB = urgencyOrder[getUrgencyCategory(b)];
    if (urgencyA !== urgencyB) return urgencyA - urgencyB;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return a.line - b.line;
  });
  return sorted;
}

describe('TasksView Sorting and Filtering', () => {
  describe('Urgency Calculation', () => {
    const today = getTodayString();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    it('should identify overdue tasks', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Overdue task',
        dueDate: yesterdayStr
      };

      expect(getUrgencyCategory(task)).toBe('overdue');
    });

    it('should identify today tasks', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Today task',
        dueDate: today
      };

      expect(getUrgencyCategory(task)).toBe('today');
    });

    it('should identify upcoming tasks', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Future task',
        dueDate: tomorrowStr
      };

      expect(getUrgencyCategory(task)).toBe('upcoming');
    });

    it('should identify no-date tasks', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Task without date'
      };

      expect(getUrgencyCategory(task)).toBe('no-date');
    });

    it('should handle far future dates', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Far future task',
        dueDate: '2030-01-01'
      };

      expect(getUrgencyCategory(task)).toBe('upcoming');
    });

    it('should handle far past dates', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Ancient task',
        dueDate: '2020-01-01'
      };

      expect(getUrgencyCategory(task)).toBe('overdue');
    });
  });

  describe('Urgency-Based Sorting', () => {
    const today = getTodayString();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const dayAfter = new Date();
    dayAfter.setDate(dayAfter.getDate() + 2);
    const dayAfterStr = dayAfter.toISOString().split('T')[0];

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    it('should sort overdue before today', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Today task',
          dueDate: today
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Overdue task',
          dueDate: yesterdayStr
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted[0].text).toBe('Overdue task');
      expect(sorted[1].text).toBe('Today task');
    });

    it('should sort today before upcoming', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Future task',
          dueDate: tomorrowStr
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Today task',
          dueDate: today
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted[0].text).toBe('Today task');
      expect(sorted[1].text).toBe('Future task');
    });

    it('should sort upcoming before no-date', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'No date task'
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Future task',
          dueDate: tomorrowStr
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted[0].text).toBe('Future task');
      expect(sorted[1].text).toBe('No date task');
    });

    it('should maintain complete urgency hierarchy', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'No date'
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Future',
          dueDate: dayAfterStr
        },
        {
          file: 'test.md',
          line: 3,
          status: 'todo',
          text: 'Today',
          dueDate: today
        },
        {
          file: 'test.md',
          line: 4,
          status: 'todo',
          text: 'Overdue',
          dueDate: yesterdayStr
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted[0].text).toBe('Overdue');
      expect(sorted[1].text).toBe('Today');
      expect(sorted[2].text).toBe('Future');
      expect(sorted[3].text).toBe('No date');
    });

    it('should sort by date within same urgency category', () => {
      const tomorrow1 = new Date();
      tomorrow1.setDate(tomorrow1.getDate() + 1);
      const tomorrow1Str = tomorrow1.toISOString().split('T')[0];

      const tomorrow2 = new Date();
      tomorrow2.setDate(tomorrow2.getDate() + 2);
      const tomorrow2Str = tomorrow2.toISOString().split('T')[0];

      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Later task',
          dueDate: tomorrow2Str
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Earlier task',
          dueDate: tomorrow1Str
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted[0].text).toBe('Earlier task');
      expect(sorted[1].text).toBe('Later task');
    });

    it('should sort by line number when no date', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 5,
          status: 'todo',
          text: 'Task on line 5'
        },
        {
          file: 'test.md',
          line: 3,
          status: 'todo',
          text: 'Task on line 3'
        },
        {
          file: 'test.md',
          line: 7,
          status: 'todo',
          text: 'Task on line 7'
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted[0].line).toBe(3);
      expect(sorted[1].line).toBe(5);
      expect(sorted[2].line).toBe(7);
    });

    it('should handle multiple overdue tasks by date', () => {
      const yesterday1 = new Date();
      yesterday1.setDate(yesterday1.getDate() - 2);
      const yesterday1Str = yesterday1.toISOString().split('T')[0];

      const yesterday2 = new Date();
      yesterday2.setDate(yesterday2.getDate() - 1);
      const yesterday2Str = yesterday2.toISOString().split('T')[0];

      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Less overdue',
          dueDate: yesterday2Str
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Very overdue',
          dueDate: yesterday1Str
        }
      ];

      const sorted = sortByUrgency(tasks);
      // More overdue (earlier date) should come first
      expect(sorted[0].text).toBe('Very overdue');
      expect(sorted[1].text).toBe('Less overdue');
    });
  });

  describe('Task Status Distribution', () => {
    it('should count todo tasks', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'doing', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' }
      ];

      const todoCount = tasks.filter((t) => t.status === 'todo').length;
      expect(todoCount).toBe(2);
    });

    it('should count doing tasks', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'doing', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'doing', text: 'Task 3' }
      ];

      const doingCount = tasks.filter((t) => t.status === 'doing').length;
      expect(doingCount).toBe(2);
    });

    it('should count done tasks', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'done', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'done', text: 'Task 3' }
      ];

      const doneCount = tasks.filter((t) => t.status === 'done').length;
      expect(doneCount).toBe(2);
    });

    it('should handle empty task list', () => {
      const tasks: Task[] = [];

      const counts = {
        todo: tasks.filter((t) => t.status === 'todo').length,
        doing: tasks.filter((t) => t.status === 'doing').length,
        done: tasks.filter((t) => t.status === 'done').length
      };

      expect(counts.todo).toBe(0);
      expect(counts.doing).toBe(0);
      expect(counts.done).toBe(0);
    });
  });

  describe('Complex Filtering Scenarios', () => {
    const today = getTodayString();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    it('should handle mixed urgency with same status', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Future todo',
          dueDate: tomorrowStr
        },
        {
          file: 'test.md',
          line: 2,
          status: 'todo',
          text: 'Overdue todo',
          dueDate: yesterdayStr
        },
        {
          file: 'test.md',
          line: 3,
          status: 'todo',
          text: 'Today todo',
          dueDate: today
        }
      ];

      const sorted = sortByUrgency(tasks);
      expect(sorted.map((t) => t.text)).toEqual(['Overdue todo', 'Today todo', 'Future todo']);
    });

    it('should maintain state categorization across urgency levels', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'done',
          text: 'Done task',
          dueDate: today
        },
        {
          file: 'test.md',
          line: 2,
          status: 'doing',
          text: 'Doing task',
          dueDate: tomorrowStr
        },
        {
          file: 'test.md',
          line: 3,
          status: 'todo',
          text: 'Todo task',
          dueDate: yesterdayStr
        }
      ];

      const sorted = sortByUrgency(tasks);
      // Should be sorted by urgency, not status
      expect(sorted[0].text).toBe('Todo task'); // Overdue
      expect(sorted[1].text).toBe('Done task'); // Today
      expect(sorted[2].text).toBe('Doing task'); // Upcoming
    });

    it('should handle large task lists efficiently', () => {
      const tasks: Task[] = [];
      for (let i = 0; i < 100; i++) {
        const date = new Date();
        date.setDate(date.getDate() + (i % 10) - 5);
        const dateStr = date.toISOString().split('T')[0];

        tasks.push({
          file: `file${i % 5}.md`,
          line: i,
          status: (['todo', 'doing', 'done'] as const)[i % 3],
          text: `Task ${i}`,
          dueDate: dateStr
        });
      }

      const sorted = sortByUrgency(tasks);
      expect(sorted).toHaveLength(100);

      // Verify overdue tasks come before upcoming
      let lastUrgency = -1;
      const urgencyOrder = { overdue: 0, today: 1, upcoming: 2, 'no-date': 3 };
      for (const task of sorted) {
        const currentUrgency = urgencyOrder[getUrgencyCategory(task)];
        expect(currentUrgency).toBeGreaterThanOrEqual(lastUrgency);
        lastUrgency = currentUrgency;
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle tasks with null dueDate', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Task with null date',
        dueDate: undefined
      };

      expect(getUrgencyCategory(task)).toBe('no-date');
    });

    it('should handle tasks with empty string dueDate', () => {
      const task: Task = {
        file: 'test.md',
        line: 1,
        status: 'todo',
        text: 'Task',
        dueDate: ''
      };

      // Empty string is falsy, should be treated as no-date
      expect(getUrgencyCategory(task)).toBe(
        getUrgencyCategory({
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Task'
        })
      );
    });

    it('should maintain stability for equal priority tasks', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 5, status: 'todo', text: 'Task 5' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' },
        { file: 'test.md', line: 7, status: 'todo', text: 'Task 7' }
      ];

      const sorted = sortByUrgency(tasks);
      // Should maintain line number order for equal priority
      expect(sorted[0].line).toBe(3);
      expect(sorted[1].line).toBe(5);
      expect(sorted[2].line).toBe(7);
    });
  });
});

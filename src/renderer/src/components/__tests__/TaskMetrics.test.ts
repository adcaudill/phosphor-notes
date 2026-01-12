import { describe, it, expect } from 'vitest';

/**
 * Test suite for task status metrics and statistics
 * Tests completion rates, urgency distributions, and task analytics
 */

interface Task {
  file: string;
  line: number;
  status: 'todo' | 'doing' | 'done';
  text: string;
  dueDate?: string;
  completedAt?: string;
}

function getTodayString(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Metric calculation functions
 */

function getTaskCounts(tasks: Task[]): {
  total: number;
  todo: number;
  doing: number;
  done: number;
} {
  return {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    doing: tasks.filter((t) => t.status === 'doing').length,
    done: tasks.filter((t) => t.status === 'done').length
  };
}

function getCompletionRate(tasks: Task[]): number {
  const counts = getTaskCounts(tasks);
  if (counts.total === 0) return 0;
  return (counts.done / counts.total) * 100;
}

function getOverdueCount(tasks: Task[]): number {
  const today = getTodayString();
  return tasks.filter((t) => t.dueDate && t.dueDate < today && t.status !== 'done').length;
}

function getUrgentCount(tasks: Task[]): number {
  const today = getTodayString();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  return tasks.filter((t) => t.dueDate && t.dueDate <= tomorrowStr && t.status !== 'done').length;
}

function getTasksByFile(tasks: Task[]): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {};
  tasks.forEach((task) => {
    if (!grouped[task.file]) {
      grouped[task.file] = [];
    }
    grouped[task.file].push(task);
  });
  return grouped;
}

function getTasksByStatus(tasks: Task[]): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {
    todo: [],
    doing: [],
    done: []
  };
  tasks.forEach((task) => {
    grouped[task.status].push(task);
  });
  return grouped;
}

describe('Task Status Metrics', () => {
  describe('Task Counting', () => {
    it('should count tasks by status', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'doing', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'doing', text: 'Task 3' },
        { file: 'test.md', line: 4, status: 'done', text: 'Task 4' },
        { file: 'test.md', line: 5, status: 'done', text: 'Task 5' },
        { file: 'test.md', line: 6, status: 'done', text: 'Task 6' }
      ];

      const counts = getTaskCounts(tasks);
      expect(counts.total).toBe(6);
      expect(counts.todo).toBe(1);
      expect(counts.doing).toBe(2);
      expect(counts.done).toBe(3);
    });

    it('should handle empty task list', () => {
      const counts = getTaskCounts([]);
      expect(counts.total).toBe(0);
      expect(counts.todo).toBe(0);
      expect(counts.doing).toBe(0);
      expect(counts.done).toBe(0);
    });

    it('should handle all tasks in single status', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'todo', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' }
      ];

      const counts = getTaskCounts(tasks);
      expect(counts.total).toBe(3);
      expect(counts.todo).toBe(3);
      expect(counts.doing).toBe(0);
      expect(counts.done).toBe(0);
    });

    it('should count large task sets efficiently', () => {
      const tasks: Task[] = [];
      for (let i = 0; i < 1000; i++) {
        tasks.push({
          file: `file${i % 10}.md`,
          line: i,
          status: (['todo', 'doing', 'done'] as const)[i % 3],
          text: `Task ${i}`
        });
      }

      const counts = getTaskCounts(tasks);
      expect(counts.total).toBe(1000);
      expect(counts.todo).toBe(Math.ceil(1000 / 3));
      expect(counts.doing).toBe(Math.floor(1000 / 3));
    });
  });

  describe('Completion Rate', () => {
    it('should calculate 0% completion for all pending tasks', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'todo', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' }
      ];

      expect(getCompletionRate(tasks)).toBe(0);
    });

    it('should calculate 100% completion for all done tasks', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'done', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'done', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'done', text: 'Task 3' }
      ];

      expect(getCompletionRate(tasks)).toBe(100);
    });

    it('should calculate 50% completion rate', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'done', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'done', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' },
        { file: 'test.md', line: 4, status: 'todo', text: 'Task 4' }
      ];

      expect(getCompletionRate(tasks)).toBe(50);
    });

    it('should return 0 for empty task list', () => {
      expect(getCompletionRate([])).toBe(0);
    });

    it('should calculate 33.33% completion rate', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'done', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'todo', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' }
      ];

      const rate = getCompletionRate(tasks);
      expect(rate).toBeCloseTo(33.33, 1);
    });

    it('should handle doing tasks as incomplete', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'done', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'doing', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'todo', text: 'Task 3' }
      ];

      expect(getCompletionRate(tasks)).toBeCloseTo(33.33, 1);
    });
  });

  describe('Overdue Task Tracking', () => {
    const today = getTodayString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    it('should count overdue incomplete tasks', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Overdue task',
          dueDate: yesterdayStr
        },
        {
          file: 'test.md',
          line: 2,
          status: 'doing',
          text: 'Another overdue task',
          dueDate: yesterdayStr
        },
        {
          file: 'test.md',
          line: 3,
          status: 'done',
          text: 'Done overdue task',
          dueDate: yesterdayStr
        }
      ];

      expect(getOverdueCount(tasks)).toBe(2);
    });

    it('should not count done tasks as overdue', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'done',
          text: 'Completed overdue',
          dueDate: yesterdayStr
        }
      ];

      expect(getOverdueCount(tasks)).toBe(0);
    });

    it('should not count future tasks as overdue', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Future task',
          dueDate: tomorrowStr
        }
      ];

      expect(getOverdueCount(tasks)).toBe(0);
    });

    it('should return 0 for no overdue tasks', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Today task',
          dueDate: today
        }
      ];

      expect(getOverdueCount(tasks)).toBe(0);
    });
  });

  describe('Urgent Task Tracking', () => {
    it('should count tasks due today or tomorrow', () => {
      const today = getTodayString();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Due today',
          dueDate: today
        },
        {
          file: 'test.md',
          line: 2,
          status: 'doing',
          text: 'Due tomorrow',
          dueDate: tomorrowStr
        }
      ];

      expect(getUrgentCount(tasks)).toBe(2);
    });

    it('should not count done urgent tasks', () => {
      const today = getTodayString();
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'done',
          text: 'Done today',
          dueDate: today
        }
      ];

      expect(getUrgentCount(tasks)).toBe(0);
    });

    it('should not count future non-urgent tasks', () => {
      const inThreeDays = new Date();
      inThreeDays.setDate(inThreeDays.getDate() + 3);
      const inThreeDaysStr = inThreeDays.toISOString().split('T')[0];

      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 1,
          status: 'todo',
          text: 'Future task',
          dueDate: inThreeDaysStr
        }
      ];

      expect(getUrgentCount(tasks)).toBe(0);
    });
  });

  describe('Grouping and Organization', () => {
    it('should group tasks by file', () => {
      const tasks: Task[] = [
        { file: 'file1.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'file1.md', line: 2, status: 'todo', text: 'Task 2' },
        { file: 'file2.md', line: 1, status: 'done', text: 'Task 3' },
        { file: 'file3.md', line: 1, status: 'doing', text: 'Task 4' }
      ];

      const grouped = getTasksByFile(tasks);
      expect(Object.keys(grouped)).toContain('file1.md');
      expect(Object.keys(grouped)).toContain('file2.md');
      expect(Object.keys(grouped)).toContain('file3.md');
      expect(grouped['file1.md']).toHaveLength(2);
      expect(grouped['file2.md']).toHaveLength(1);
      expect(grouped['file3.md']).toHaveLength(1);
    });

    it('should group tasks by status', () => {
      const tasks: Task[] = [
        { file: 'test.md', line: 1, status: 'todo', text: 'Task 1' },
        { file: 'test.md', line: 2, status: 'todo', text: 'Task 2' },
        { file: 'test.md', line: 3, status: 'doing', text: 'Task 3' },
        { file: 'test.md', line: 4, status: 'done', text: 'Task 4' }
      ];

      const grouped = getTasksByStatus(tasks);
      expect(grouped.todo).toHaveLength(2);
      expect(grouped.doing).toHaveLength(1);
      expect(grouped.done).toHaveLength(1);
    });

    it('should handle empty groups', () => {
      const tasks: Task[] = [{ file: 'test.md', line: 1, status: 'todo', text: 'Task 1' }];

      const grouped = getTasksByStatus(tasks);
      expect(grouped.todo).toHaveLength(1);
      expect(grouped.doing).toHaveLength(0);
      expect(grouped.done).toHaveLength(0);
    });

    it('should preserve task data when grouping', () => {
      const tasks: Task[] = [
        {
          file: 'test.md',
          line: 5,
          status: 'todo',
          text: 'Important task',
          dueDate: getTodayString()
        }
      ];

      const grouped = getTasksByStatus(tasks);
      expect(grouped.todo[0].line).toBe(5);
      expect(grouped.todo[0].dueDate).toBeDefined();
    });
  });

  describe('Analytics Scenarios', () => {
    it('should calculate metrics for project with mixed statuses', () => {
      const tasks: Task[] = [
        { file: 'file1.md', line: 1, status: 'done', text: 'Completed 1' },
        { file: 'file1.md', line: 2, status: 'done', text: 'Completed 2' },
        { file: 'file2.md', line: 1, status: 'doing', text: 'In Progress 1' },
        { file: 'file2.md', line: 2, status: 'todo', text: 'Not Started 1' },
        { file: 'file2.md', line: 3, status: 'todo', text: 'Not Started 2' },
        { file: 'file2.md', line: 4, status: 'todo', text: 'Not Started 3' }
      ];

      const counts = getTaskCounts(tasks);
      const rate = getCompletionRate(tasks);
      const byFile = getTasksByFile(tasks);
      const byStatus = getTasksByStatus(tasks);

      expect(counts.total).toBe(6);
      expect(counts.done).toBe(2);
      expect(rate).toBeCloseTo(33.33, 1);
      expect(Object.keys(byFile)).toHaveLength(2);
      expect(byStatus.done).toHaveLength(2);
      expect(byStatus.doing).toHaveLength(1);
      expect(byStatus.todo).toHaveLength(3);
    });

    it('should handle single file with all statuses', () => {
      const tasks: Task[] = [
        { file: 'all.md', line: 1, status: 'todo', text: 'Task' },
        { file: 'all.md', line: 2, status: 'doing', text: 'Task' },
        { file: 'all.md', line: 3, status: 'done', text: 'Task' }
      ];

      const byFile = getTasksByFile(tasks);
      expect(byFile['all.md']).toHaveLength(3);
    });

    it('should calculate metrics for completed project', () => {
      const tasks: Task[] = [
        {
          file: 'file1.md',
          line: 1,
          status: 'done',
          text: 'Task 1',
          completedAt: getTodayString()
        },
        {
          file: 'file1.md',
          line: 2,
          status: 'done',
          text: 'Task 2',
          completedAt: getTodayString()
        }
      ];

      const rate = getCompletionRate(tasks);
      const overdue = getOverdueCount(tasks);
      expect(rate).toBe(100);
      expect(overdue).toBe(0);
    });
  });

  describe('Edge Cases and Large Datasets', () => {
    it('should handle single task', () => {
      const tasks: Task[] = [{ file: 'test.md', line: 1, status: 'todo', text: 'Single task' }];

      expect(getTaskCounts(tasks).total).toBe(1);
      expect(getCompletionRate(tasks)).toBe(0);
    });

    it('should handle very large task list', () => {
      const tasks: Task[] = [];
      for (let i = 0; i < 10000; i++) {
        tasks.push({
          file: `file${i % 100}.md`,
          line: i,
          status: (['todo', 'doing', 'done'] as const)[i % 3],
          text: `Task ${i}`
        });
      }

      const counts = getTaskCounts(tasks);
      expect(counts.total).toBe(10000);
      expect(counts.todo + counts.doing + counts.done).toBe(10000);
    });

    it('should handle tasks with no metadata', () => {
      const tasks: Task[] = [{ file: 'test.md', line: 1, status: 'todo', text: 'Task' }];

      expect(getOverdueCount(tasks)).toBe(0);
      expect(getUrgentCount(tasks)).toBe(0);
    });

    it('should handle all task variations', () => {
      const today = getTodayString();
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const tasks: Task[] = [
        {
          file: 'file1.md',
          line: 1,
          status: 'todo',
          text: 'Task with no date'
        },
        {
          file: 'file1.md',
          line: 2,
          status: 'done',
          text: 'Done task',
          dueDate: today,
          completedAt: today
        },
        {
          file: 'file2.md',
          line: 1,
          status: 'doing',
          text: 'Overdue in progress',
          dueDate: yesterdayStr
        }
      ];

      const counts = getTaskCounts(tasks);
      const overdue = getOverdueCount(tasks);
      expect(counts.total).toBe(3);
      expect(overdue).toBe(1);
    });
  });
});

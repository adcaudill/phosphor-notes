import { describe, it, expect } from 'vitest';

/**
 * Test suite for task extraction logic from markdown content
 * These tests validate the regex patterns and extraction logic
 * used by the indexer worker
 */

describe('Task Extraction (Indexer Logic)', () => {
  /**
   * Simulate the extractTasks function from worker/indexer.ts
   * Tests focus on the regex patterns and metadata extraction
   */
  type Task = {
    line: number;
    status: 'todo' | 'doing' | 'done';
    text: string;
    dueDate?: string;
    completedAt?: string;
  };

  const extractTasksFromContent = (content: string): Task[] => {
    const tasks: Task[] = [];
    const taskRegex = /^\s*-\s*\[([ x/])\]\s*(.*)$/gm;

    let match: RegExpExecArray | null;
    while ((match = taskRegex.exec(content)) !== null) {
      const status = match[1] === ' ' ? 'todo' : match[1] === '/' ? 'doing' : 'done';
      const text = match[2].trim();
      const line = content.substring(0, match.index).split('\n').length;

      let dueDate: string | undefined;
      const emojiDateMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
      if (emojiDateMatch) {
        dueDate = emojiDateMatch[1];
      }

      if (!dueDate) {
        const orgDateMatch = text.match(/DEADLINE:\s*<(\d{4}-\d{2}-\d{2})/i);
        if (orgDateMatch) {
          dueDate = orgDateMatch[1];
        }
      }

      let completedAt: string | undefined;
      const completeMatch = text.match(/✓\s*(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
      if (completeMatch) {
        completedAt = completeMatch[1];
      }

      tasks.push({
        line,
        status,
        text,
        dueDate,
        completedAt
      });
    }

    return tasks;
  };

  describe('Task detection', () => {
    it('should detect todo tasks', () => {
      const content = '- [ ] Buy groceries';
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('todo');
    });

    it('should detect doing tasks', () => {
      const content = '- [/] In progress';
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('doing');
    });

    it('should detect done tasks', () => {
      const content = '- [x] Completed';
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('done');
    });

    it('should handle tasks with leading whitespace', () => {
      const content = '  - [ ] Indented task';
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].text).toBe('Indented task');
    });

    it('should ignore non-task markdown lists', () => {
      const content = '- Not a task\n- [ ] Real task';
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].text).toBe('Real task');
    });

    it('should extract multiple tasks', () => {
      const content = `- [ ] Task 1
- [/] Task 2
- [x] Task 3`;
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe('todo');
      expect(tasks[1].status).toBe('doing');
      expect(tasks[2].status).toBe('done');
    });
  });

  describe('Line number tracking', () => {
    it('should correctly identify line number of first task', () => {
      const content = '- [ ] First task';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].line).toBe(1);
    });

    it('should correctly identify line numbers with preceding content', () => {
      const content = `# Header
Some text
- [ ] Task on line 3`;
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].line).toBe(3);
    });

    it('should handle multiple tasks on different lines', () => {
      const content = `- [ ] Line 1
More text
- [x] Line 3
- [/] Line 4`;
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].line).toBe(1);
      expect(tasks[1].line).toBe(3);
      expect(tasks[2].line).toBe(4);
    });
  });

  describe('Due date extraction - emoji style', () => {
    it('should extract emoji-style due date', () => {
      const content = '- [ ] Task 📅 2026-01-15';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should extract emoji-style due date with extra space', () => {
      const content = '- [ ] Task 📅  2026-01-15';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should handle multiple emoji dates (extracts first)', () => {
      const content = '- [ ] Task 📅 2026-01-15 📅 2026-01-20';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });
  });

  describe('Due date extraction - Org-mode style', () => {
    it('should extract Org-mode DEADLINE', () => {
      const content = '- [ ] Task DEADLINE: <2026-01-15>';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should extract Org-mode DEADLINE with no space', () => {
      const content = '- [ ] Task DEADLINE:<2026-01-15>';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should extract Org-mode DEADLINE case-insensitive', () => {
      const content = '- [ ] Task deadline: <2026-01-15>';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should ignore Org-mode date without brackets', () => {
      const content = '- [ ] Task DEADLINE: 2026-01-15';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBeUndefined();
    });

    it('should prioritize emoji style over Org-mode', () => {
      const content = '- [ ] Task 📅 2026-01-10 DEADLINE: <2026-01-20>';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].dueDate).toBe('2026-01-10');
    });
  });

  describe('Completion timestamp extraction', () => {
    it('should extract completion timestamp', () => {
      const content = '- [x] Task ✓ 2026-01-12 14:30:45';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].completedAt).toBe('2026-01-12 14:30:45');
    });

    it('should extract timestamp with space after checkmark', () => {
      const content = '- [x] Task ✓  2026-01-12 14:30:45';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].completedAt).toBe('2026-01-12 14:30:45');
    });

    it('should not extract timestamp on non-done tasks', () => {
      const content = '- [ ] Todo ✓ 2026-01-12 14:30:45';
      const tasks = extractTasksFromContent(content);
      // Should still extract it from text, but typically timestamps only make sense on done tasks
      expect(tasks[0].completedAt).toBe('2026-01-12 14:30:45');
    });
  });

  describe('Complex task scenarios', () => {
    it('should extract all metadata from a complex task', () => {
      const content = '- [x] Team meeting DEADLINE: <2026-01-15> 🔁 +1w ✓ 2026-01-12 10:00:00';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].status).toBe('done');
      expect(tasks[0].dueDate).toBe('2026-01-15');
      expect(tasks[0].completedAt).toBe('2026-01-12 10:00:00');
      expect(tasks[0].text).toContain('Team meeting');
      expect(tasks[0].text).toContain('🔁 +1w');
    });

    it('should extract tasks from markdown with headers and text', () => {
      const content = `# My Tasks

## Today
- [ ] Buy milk 📅 2026-01-12
- [/] Write report DEADLINE: <2026-01-15>

## Backlog
- [ ] Research
- [x] Completed ✓ 2026-01-11 15:00:00`;
      const tasks = extractTasksFromContent(content);
      expect(tasks).toHaveLength(4);
      expect(tasks[0].text).toBe('Buy milk 📅 2026-01-12');
      expect(tasks[1].text).toContain('Write report');
      expect(tasks[3].completedAt).toBe('2026-01-11 15:00:00');
    });

    it('should handle tasks with special characters', () => {
      const content = '- [ ] Fix bug #123 in module@core 📅 2026-01-15';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].text).toContain('Fix bug #123');
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should handle tasks with code snippets', () => {
      const content = '- [ ] Review `const x = 5;` 📅 2026-01-15';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].text).toContain('Review `const x = 5;`');
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });

    it('should handle tasks with URLs', () => {
      const content = '- [ ] Check https://example.com 📅 2026-01-15';
      const tasks = extractTasksFromContent(content);
      expect(tasks[0].text).toContain('https://example.com');
      expect(tasks[0].dueDate).toBe('2026-01-15');
    });
  });
});

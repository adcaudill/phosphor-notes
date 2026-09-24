import { describe, it, expect } from 'vitest';
import {
  parseTaskLine,
  extractTasksFromContent,
  serializeTaskMetadata,
  serializeTaskLine,
  cycleStatus,
  computeNextOccurrence,
  buildRecurrenceAdvance,
  toggleTaskLine,
  formatTaskLine,
  getCurrentTimestamp,
  formatTimestamp,
  todayString,
  isPastDate,
  isTodayDate,
  isFutureDate,
  TASK_LINE_RE
} from '../tasks';
import { InvalidArgumentError } from '../noteFormat';

describe('parseTaskLine', () => {
  it('returns null for a non-task line', () => {
    expect(parseTaskLine('Just some text')).toBeNull();
    expect(parseTaskLine('- a plain bullet')).toBeNull();
  });

  it('parses the three statuses', () => {
    expect(parseTaskLine('- [ ] todo')?.status).toBe('todo');
    expect(parseTaskLine('- [/] doing')?.status).toBe('doing');
    expect(parseTaskLine('- [x] done')?.status).toBe('done');
  });

  it('preserves leading indent in rawText but not in text', () => {
    const parsed = parseTaskLine('    - [ ] indented task');
    expect(parsed?.rawText).toBe('    - [ ] indented task');
    expect(parsed?.text).toBe('indented task');
  });

  it('parses the canonical emoji due date', () => {
    const parsed = parseTaskLine('- [ ] Buy groceries 📅 2026-01-15');
    expect(parsed?.dueDate).toBe('2026-01-15');
    expect(parsed?.text).toBe('Buy groceries');
  });

  it('parses the canonical emoji due date with extra spacing', () => {
    const parsed = parseTaskLine('- [ ] Buy groceries 📅  2026-01-15');
    expect(parsed?.dueDate).toBe('2026-01-15');
  });

  it('parses legacy @due() (Logseq import, read-only)', () => {
    const parsed = parseTaskLine('- [ ] Renew passport @due(2026-11-01)');
    expect(parsed?.dueDate).toBe('2026-11-01');
    expect(parsed?.text).toBe('Renew passport');
  });

  it('parses legacy Org DEADLINE: without stripping it from text (matches original behavior)', () => {
    const parsed = parseTaskLine('- [ ] Task Name DEADLINE: <2026-01-15>');
    expect(parsed?.dueDate).toBe('2026-01-15');
    expect(parsed?.text).toContain('DEADLINE:');
  });

  it('parses Org DEADLINE case-insensitively and with no space after colon', () => {
    expect(parseTaskLine('- [ ] x deadline: <2026-01-15>')?.dueDate).toBe('2026-01-15');
    expect(parseTaskLine('- [ ] x DEADLINE:<2026-01-15>')?.dueDate).toBe('2026-01-15');
  });

  it('leaves SCHEDULED: as inert text (no dedicated field, never stripped)', () => {
    const parsed = parseTaskLine('- [ ] Prepare report SCHEDULED: <2026-02-03>');
    expect(parsed?.text).toContain('SCHEDULED: <2026-02-03>');
    expect(parsed?.dueDate).toBeUndefined();
  });

  it('prioritizes emoji due date over Org DEADLINE', () => {
    const parsed = parseTaskLine('- [ ] x 📅 2026-01-10 DEADLINE: <2026-01-20>');
    expect(parsed?.dueDate).toBe('2026-01-10');
  });

  it('parses the canonical emoji recurrence for all four units', () => {
    for (const [suffix, unit] of [
      ['+1d', 'd'],
      ['+2w', 'w'],
      ['+3m', 'm'],
      ['+1y', 'y']
    ] as const) {
      const parsed = parseTaskLine(`- [ ] task 🔁 ${suffix}`);
      expect(parsed?.recurrence).toEqual({
        amount: parseInt(suffix.slice(1, -1), 10),
        unit,
        supported: true
      });
    }
  });

  it('parses legacy @repeat() with a supported unit', () => {
    const parsed = parseTaskLine('- [ ] x @repeat(2w)');
    expect(parsed?.recurrence).toEqual({ amount: 2, unit: 'w', supported: true });
  });

  it('fixes the m/M collision bug: lowercase m is months, uppercase M is minutes-and-unsupported', () => {
    const months = parseTaskLine('- [ ] x @repeat(3m)');
    expect(months?.recurrence).toEqual({ amount: 3, unit: 'm', supported: true });

    const minutes = parseTaskLine('- [ ] x @repeat(3M)');
    expect(minutes?.recurrence).toEqual({ amount: 3, unit: 'M', raw: '@repeat(3M)', supported: false });
  });

  it('flags legacy h/S @repeat() units as unsupported rather than silently wrong', () => {
    expect(parseTaskLine('- [ ] x @repeat(5h)')?.recurrence).toEqual({
      amount: 5,
      unit: 'h',
      raw: '@repeat(5h)',
      supported: false
    });
    expect(parseTaskLine('- [ ] x @repeat(5S)')?.recurrence).toEqual({
      amount: 5,
      unit: 'S',
      raw: '@repeat(5S)',
      supported: false
    });
  });

  it('parses the completion timestamp', () => {
    const parsed = parseTaskLine('- [x] Completed task ✓ 2026-01-12 14:30:45');
    expect(parsed?.completedAt).toBe('2026-01-12 14:30:45');
    expect(parsed?.text).toBe('Completed task');
  });

  it('parses a new priority marker and strips it from text', () => {
    expect(parseTaskLine('- [ ] Ship it 🔺')?.priority).toBe('high');
    expect(parseTaskLine('- [ ] Ship it 🔼')?.priority).toBe('medium');
    expect(parseTaskLine('- [ ] Ship it 🔽')?.priority).toBe('low');
    expect(parseTaskLine('- [ ] Ship it 🔺')?.text).toBe('Ship it');
  });

  it('has no priority field when no marker is present', () => {
    expect(parseTaskLine('- [ ] Ship it')?.priority).toBeUndefined();
  });

  it('parses all metadata together, in any written order, cleaning text fully', () => {
    const parsed = parseTaskLine('- [ ] Team sync 🔺 📅 2026-01-15 🔁 +1w ✓ 2026-01-12 10:00:00');
    expect(parsed?.text).toBe('Team sync');
    expect(parsed?.priority).toBe('high');
    expect(parsed?.dueDate).toBe('2026-01-15');
    expect(parsed?.recurrence).toEqual({ amount: 1, unit: 'w', supported: true });
    expect(parsed?.completedAt).toBe('2026-01-12 10:00:00');
  });

  it('does not extract a date without an emoji/notation marker', () => {
    expect(parseTaskLine('- [ ] Task due on 2026-01-15')?.dueDate).toBeUndefined();
  });
});

describe('extractTasksFromContent', () => {
  it('extracts tasks with correct 1-indexed line numbers', () => {
    const content = '# Title\n- [ ] first task\nSome text\n- [x] done task\n';
    const tasks = extractTasksFromContent(content, 'note.md');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ file: 'note.md', line: 2, status: 'todo', text: 'first task' });
    expect(tasks[1]).toMatchObject({ file: 'note.md', line: 4, status: 'done', text: 'done task' });
  });

  it('populates the same fields the incremental and full-scan paths both need', () => {
    const content = '- [ ] Renew passport 🔺 📅 2026-11-01 🔁 +1y\n';
    const [task] = extractTasksFromContent(content, 'a.md');
    expect(task.dueDate).toBe('2026-11-01');
    expect(task.priority).toBe('high');
    expect(task.recurrence).toEqual({ amount: 1, unit: 'y', supported: true });
    expect(task.rawText).toBe('- [ ] Renew passport 🔺 📅 2026-11-01 🔁 +1y');
  });
});

describe('serializeTaskMetadata / serializeTaskLine', () => {
  it('orders priority, due, recurrence, completion', () => {
    expect(
      serializeTaskMetadata({
        priority: 'high',
        due: '2026-01-15',
        recurrence: { amount: 1, unit: 'w' },
        completedAt: '2026-01-12 10:00:00'
      })
    ).toBe('🔺 📅 2026-01-15 🔁 +1w ✓ 2026-01-12 10:00:00');
  });

  it('serializeTaskLine round-trips through parseTaskLine', () => {
    const line = serializeTaskLine('  ', 'todo', 'Write report', {
      due: '2026-01-15',
      priority: 'medium'
    });
    expect(line).toBe('  - [ ] Write report 🔼 📅 2026-01-15');
    const reparsed = parseTaskLine(line);
    expect(reparsed?.text).toBe('Write report');
    expect(reparsed?.dueDate).toBe('2026-01-15');
    expect(reparsed?.priority).toBe('medium');
  });
});

describe('cycleStatus', () => {
  it('cycles todo -> doing -> done -> todo', () => {
    expect(cycleStatus('todo')).toBe('doing');
    expect(cycleStatus('doing')).toBe('done');
    expect(cycleStatus('done')).toBe('todo');
  });
});

describe('computeNextOccurrence', () => {
  it('advances by days/weeks/months/years', () => {
    const rec = (unit: 'd' | 'w' | 'm' | 'y', amount = 1): import('../tasks').Recurrence => ({
      amount,
      unit,
      supported: true
    });
    expect(computeNextOccurrence('2026-01-15', rec('d'), { today: '2020-01-01' })).toBe('2026-01-16');
    expect(computeNextOccurrence('2026-01-15', rec('w'), { today: '2020-01-01' })).toBe('2026-01-22');
    expect(computeNextOccurrence('2026-01-15', rec('m'), { today: '2020-01-01' })).toBe('2026-02-15');
    expect(computeNextOccurrence('2026-01-15', rec('y'), { today: '2020-01-01' })).toBe('2027-01-15');
  });

  it('handles multi-unit amounts and month/year boundaries', () => {
    expect(
      computeNextOccurrence('2026-01-15', { amount: 3, unit: 'd', supported: true }, { today: '2020-01-01' })
    ).toBe('2026-01-18');
    expect(
      computeNextOccurrence('2025-12-31', { amount: 1, unit: 'd', supported: true }, { today: '2020-01-01' })
    ).toBe('2026-01-01');
  });

  it('returns null for an unsupported unit instead of infinite-duplicating', () => {
    expect(
      computeNextOccurrence('2026-01-15', { amount: 5, unit: 'h', raw: '@repeat(5h)', supported: false })
    ).toBeNull();
  });

  it('catch-up clamp: keeps advancing until strictly after today', () => {
    // Due a year ago, daily recurrence, completed "today" - naive +1d would
    // still be far in the past; the clamp should walk it forward to tomorrow.
    const next = computeNextOccurrence(
      '2025-01-01',
      { amount: 1, unit: 'd', supported: true },
      { today: '2026-06-15' }
    );
    expect(next).toBe('2026-06-16');
  });
});

describe('buildRecurrenceAdvance', () => {
  it('marks the current line done with a timestamp and keeps its own due date/recurrence', () => {
    const { completedLine } = buildRecurrenceAdvance('- [ ] Daily standup 📅 2026-01-15 🔁 +1d', {
      now: new Date(2026, 0, 15, 9, 0, 0)
    });
    expect(completedLine).toContain('[x]');
    expect(completedLine).toContain('📅 2026-01-15');
    expect(completedLine).toContain('🔁 +1d');
    expect(completedLine).toContain('✓ 2026-01-15 09:00:00');
  });

  it('inserts a next occurrence with the advanced due date and reset status', () => {
    const { nextLine } = buildRecurrenceAdvance('- [ ] Daily standup 📅 2026-01-15 🔁 +1d', {
      now: new Date(2026, 0, 15, 9, 0, 0)
    });
    expect(nextLine).toContain('[ ]');
    expect(nextLine).toContain('📅 2026-01-16');
    expect(nextLine).not.toContain('2026-01-15');
    expect(nextLine).not.toContain('✓');
  });

  it('preserves task text and other metadata across occurrences', () => {
    const { nextLine } = buildRecurrenceAdvance('- [ ] Important daily sync 🔺 📅 2026-01-15 🔁 +1d');
    expect(nextLine).toContain('Important daily sync');
    expect(nextLine).toContain('🔺');
  });

  it('produces no next line for a non-recurring task', () => {
    const { completedLine, nextLine } = buildRecurrenceAdvance('- [ ] One-time task 📅 2026-01-15');
    expect(completedLine).toContain('[x]');
    expect(nextLine).toBeNull();
  });

  it('produces no next line when recurrence has no due date', () => {
    const { nextLine } = buildRecurrenceAdvance('- [ ] Task 🔁 +1d');
    expect(nextLine).toBeNull();
  });

  it('produces no next line for an unsupported legacy recurrence unit (fixes the infinite-duplicate bug)', () => {
    const { completedLine, nextLine } = buildRecurrenceAdvance('- [ ] Old import @repeat(5M) @due(2026-01-15)');
    expect(completedLine).toContain('[x]');
    expect(nextLine).toBeNull();
  });

  it('handles month/leap-year boundaries without throwing', () => {
    const { nextLine } = buildRecurrenceAdvance('- [ ] Task 📅 2026-01-31 🔁 +1m');
    expect(nextLine).toMatch(/📅 \d{4}-\d{2}-\d{2}/);
  });
});

describe('toggleTaskLine', () => {
  it('cycles a plain task through todo -> doing -> done -> todo', () => {
    let line = '- [ ] Simple task';
    line = toggleTaskLine(line)[0];
    expect(line).toContain('[/]');
    line = toggleTaskLine(line)[0];
    expect(line).toContain('[x]');
    expect(line).toContain('✓');
    line = toggleTaskLine(line)[0];
    expect(line).toContain('[ ]');
    expect(line).not.toContain('✓');
  });

  it('cycling todo -> doing on a recurring task does not yet generate a next occurrence', () => {
    const lines = toggleTaskLine('- [ ] Daily standup 📅 2026-01-15 🔁 +1d');
    expect(lines).toHaveLength(1); // todo -> doing first, not done yet
    expect(lines[0]).toContain('[/]');
  });

  it('completing a doing recurring task produces the completed line plus the next occurrence', () => {
    const lines = toggleTaskLine('- [/] Daily standup 📅 2026-01-15 🔁 +1d', {
      now: new Date(2026, 0, 15, 9, 0, 0)
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[x]');
    expect(lines[1]).toContain('[ ]');
    expect(lines[1]).toContain('2026-01-16');
  });

  it('leaves a non-task line unchanged', () => {
    expect(toggleTaskLine('not a task')).toEqual(['not a task']);
  });
});

describe('formatTaskLine', () => {
  it('formats a basic task', () => {
    expect(formatTaskLine({ text: 'Write report' })).toBe('- [ ] Write report');
  });

  it('formats with a due date', () => {
    expect(formatTaskLine({ text: 'Renew passport', due: '2026-11-01' })).toBe(
      '- [ ] Renew passport 📅 2026-11-01'
    );
  });

  it('formats with due date and recurrence, date before recurrence', () => {
    expect(formatTaskLine({ text: 'Renew passport', due: '2026-11-01', recurrence: '+1y' })).toBe(
      '- [ ] Renew passport 📅 2026-11-01 🔁 +1y'
    );
  });

  it('formats with a priority before due date/recurrence', () => {
    expect(
      formatTaskLine({ text: 'Renew passport', due: '2026-11-01', priority: 'high' })
    ).toBe('- [ ] Renew passport 🔺 📅 2026-11-01');
  });

  it('formats a "doing" task with [/]', () => {
    expect(formatTaskLine({ text: 'Draft spec', status: 'doing' })).toBe('- [/] Draft spec');
  });

  it('produces output matching the task-line regex', () => {
    const line = formatTaskLine({ text: 'x', due: '2026-01-01', recurrence: '+2w' });
    expect(TASK_LINE_RE.test(line)).toBe(true);
  });

  it('strips a leading checkbox marker the caller already included', () => {
    expect(formatTaskLine({ text: '- [ ] Already bulleted' })).toBe('- [ ] Already bulleted');
    expect(formatTaskLine({ text: '[x] Done already' })).toBe('- [ ] Done already');
  });

  it('rejects multi-line text', () => {
    expect(() => formatTaskLine({ text: 'a\nb' })).toThrow(InvalidArgumentError);
  });

  it('rejects empty text', () => {
    expect(() => formatTaskLine({ text: '   ' })).toThrow(InvalidArgumentError);
  });

  it('rejects an impossible calendar date', () => {
    expect(() => formatTaskLine({ text: 'x', due: '2026-02-30' })).toThrow(InvalidArgumentError);
  });

  it('rejects a malformed recurrence', () => {
    expect(() => formatTaskLine({ text: 'x', recurrence: 'weekly' })).toThrow(InvalidArgumentError);
    expect(() => formatTaskLine({ text: 'x', recurrence: '1w' })).toThrow(InvalidArgumentError);
    expect(() => formatTaskLine({ text: 'x', recurrence: '+1x' })).toThrow(InvalidArgumentError);
  });

  it('rejects text that already embeds a due-date, recurrence, or priority emoji', () => {
    expect(() => formatTaskLine({ text: 'x 📅 2026-01-01', due: '2026-01-01' })).toThrow(
      InvalidArgumentError
    );
    expect(() => formatTaskLine({ text: 'x 🔁 +1w' })).toThrow(InvalidArgumentError);
    expect(() => formatTaskLine({ text: 'x 🔺' })).toThrow(InvalidArgumentError);
  });
});

describe('date helpers', () => {
  it('todayString formats local date as YYYY-MM-DD', () => {
    expect(todayString(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('isPastDate/isTodayDate/isFutureDate compare lexicographically against `today`', () => {
    expect(isPastDate('2026-01-01', '2026-01-15')).toBe(true);
    expect(isPastDate('2026-02-01', '2026-01-15')).toBe(false);
    expect(isTodayDate('2026-01-15', '2026-01-15')).toBe(true);
    expect(isFutureDate('2026-02-01', '2026-01-15')).toBe(true);
    expect(isFutureDate('2026-01-01', '2026-01-15')).toBe(false);
  });
});

describe('timestamp helpers', () => {
  it('getCurrentTimestamp returns YYYY-MM-DD HH:MM:SS', () => {
    expect(getCurrentTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('formatTimestamp renders a human-readable string', () => {
    expect(formatTimestamp('2026-01-12 14:30:45')).toMatch(/Jan\s+\d{1,2},\s+\d{1,2}:\d{2}\s+(AM|PM)/);
  });
});

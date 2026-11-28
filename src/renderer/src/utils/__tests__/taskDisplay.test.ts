import { describe, it, expect } from 'vitest';
import { friendlyDueLabel } from '../taskDisplay';

describe('friendlyDueLabel', () => {
  const today = '2026-11-28'; // a Saturday

  it.each([
    ['2026-11-28', 'Today', 'today'],
    ['2026-11-29', 'Tomorrow', 'future'],
    ['2026-11-27', 'Yesterday', 'overdue'],
    ['2026-12-01', 'Tue', 'future'],
    ['2026-12-04', 'Fri', 'future'],
    ['2026-12-05', 'Dec 5', 'future'],
    ['2026-11-01', 'Nov 1', 'overdue'],
    ['2027-02-10', 'Feb 10, 2027', 'future'],
    ['2025-12-31', 'Dec 31, 2025', 'overdue']
  ])('%s reads as "%s"', (due, text, status) => {
    expect(friendlyDueLabel(due, today)).toEqual({ text, status });
  });

  it('adds the time for a "due at" value', () => {
    expect(friendlyDueLabel('2026-11-28T14:30', today)).toEqual({
      text: 'Today 14:30',
      status: 'today'
    });
  });
});

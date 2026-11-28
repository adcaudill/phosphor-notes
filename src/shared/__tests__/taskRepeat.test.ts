import { describe, it, expect } from 'vitest';
import {
  addMonthsClamped,
  intervalRule,
  isValidRepeatRule,
  monthlyOnDayRule,
  nextOccurrence,
  upcomingOccurrences
} from '../taskRepeat';

const fixed = (rule: string): { rule: string; from: 'due' } => ({ rule, from: 'due' });

describe('isValidRepeatRule', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
    'FREQ=MONTHLY;BYMONTHDAY=-1',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3'
  ])('accepts %s', (rule) => expect(isValidRepeatRule(rule)).toBe(true));

  it.each([
    'FREQ=HOURLY',
    'FREQ=DAILY;COUNT=5',
    'FREQ=DAILY;UNTIL=20270101',
    'RRULE:FREQ=DAILY',
    'DTSTART:20260101\nRRULE:FREQ=DAILY',
    'INTERVAL=2',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;FREQ=WEEKLY',
    ''
  ])('rejects %s', (rule) => expect(isValidRepeatRule(rule)).toBe(false));
});

describe('month arithmetic', () => {
  it('clamps to the end of shorter months', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('builds a clamped monthly rule for days after the 28th', () => {
    expect(monthlyOnDayRule(15)).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(monthlyOnDayRule(31)).toBe('FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
    expect(upcomingOccurrences(monthlyOnDayRule(31), '2026-01-31', 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30'
    ]);
  });
});

describe('nextOccurrence (fixed schedule)', () => {
  const opts = { completedOn: '2026-11-27', today: '2026-11-27' };

  it('goes to the next date the rule allows', () => {
    expect(nextOccurrence(fixed('FREQ=MONTHLY;BYMONTHDAY=1'), '2026-12-01', opts).due).toBe(
      '2027-01-01'
    );
    expect(nextOccurrence(fixed('FREQ=WEEKLY;BYDAY=MO,TH'), '2026-11-30', opts).due).toBe(
      '2026-12-03'
    );
    expect(nextOccurrence(fixed('FREQ=MONTHLY;BYDAY=-1FR'), '2026-11-27', opts).due).toBe(
      '2026-12-25'
    );
  });

  it('keeps month-end tasks at the month end instead of drifting', () => {
    const rule = fixed(monthlyOnDayRule(31));
    const early = { completedOn: '2026-01-01', today: '2026-01-01' };
    expect(nextOccurrence(rule, '2026-01-31', early).due).toBe('2026-02-28');
    expect(nextOccurrence(rule, '2026-02-28', early).due).toBe('2026-03-31');
  });

  it('catches up past today after a late completion', () => {
    // Weekly on Thursdays, last due Oct 1, completed Nov 27 (a Friday).
    expect(nextOccurrence(fixed('FREQ=WEEKLY'), '2026-10-01', opts).due).toBe('2026-12-03');
  });

  it('carries a time of day over', () => {
    expect(nextOccurrence(fixed('FREQ=DAILY'), '2026-11-27T09:30', opts).due).toBe(
      '2026-11-28T09:30'
    );
  });

  it('ends at the until date', () => {
    const r = { ...fixed('FREQ=MONTHLY;BYMONTHDAY=1'), until: '2026-12-31' };
    expect(nextOccurrence(r, '2026-12-01', opts).due).toBeNull();
  });

  it('counts down the remaining occurrences', () => {
    const r = { ...fixed('FREQ=DAILY'), count: 3 };
    expect(nextOccurrence(r, '2026-11-28', opts)).toEqual({ due: '2026-11-29', count: 2 });
    expect(nextOccurrence({ ...r, count: 1 }, '2026-11-28', opts).due).toBeNull();
  });
});

describe('nextOccurrence (from completion)', () => {
  it('counts from the completion date, ignoring the old due date', () => {
    const r = { rule: 'FREQ=DAILY;INTERVAL=3', from: 'completion' as const };
    expect(
      nextOccurrence(r, '2026-11-01', { completedOn: '2026-11-27', today: '2026-11-27' }).due
    ).toBe('2026-11-30');
  });

  it('clamps months', () => {
    const r = { rule: 'FREQ=MONTHLY', from: 'completion' as const };
    expect(
      nextOccurrence(r, '2026-01-01', { completedOn: '2026-01-31', today: '2026-01-31' }).due
    ).toBe('2026-02-28');
  });
});

describe('intervalRule (for converting +Nd/w/m/y)', () => {
  it('anchors on the given date', () => {
    expect(intervalRule(1, 'd', '2026-11-27')).toBe('FREQ=DAILY');
    expect(intervalRule(2, 'w', '2026-11-27')).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(intervalRule(1, 'm', '2026-01-31')).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1'
    );
    expect(intervalRule(3, 'm', '2026-01-15')).toBe('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15');
    expect(intervalRule(1, 'y', '2026-03-03')).toBe('FREQ=YEARLY');
  });
});

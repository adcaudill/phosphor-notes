import { describe, it, expect } from 'vitest';
import {
  parseDatePhrase,
  parseRepeatPhrase,
  parseTaskInput,
  toNewTaskInput,
  type ParsedTaskInput
} from '../taskParse';

// Saturday 28 November 2026, 09:00 local.
const NOW = new Date(2026, 10, 28, 9, 0, 0);
const parse = (text: string, dateOrder?: 'mdy' | 'dmy'): ParsedTaskInput =>
  parseTaskInput(text, { now: NOW, dateOrder });

describe('parseTaskInput: titles', () => {
  it('leaves plain text alone', () => {
    const p = parse('Call Alice about the lease');
    expect(p).toMatchObject({ title: 'Call Alice about the lease', tags: [], tokens: [] });
    expect(p.due).toBeUndefined();
  });

  it.each([
    'March on with the plan',
    'May the best plan win',
    'Sat with Alice to review',
    'Enjoy the sun',
    'Read chapter 3',
    'Buy 2 boxes'
  ])('does not read ordinary words as dates: %s', (text) => {
    const p = parse(text);
    expect(p.title).toBe(text);
    expect(p.due).toBeUndefined();
  });

  it('keeps quoted text in the title, unparsed', () => {
    const p = parse('Call about the "1st floor" lease "every monday" fri');
    expect(p.title).toBe('Call about the 1st floor lease every monday');
    expect(p.due).toBe('2026-12-04');
    expect(p.repeat).toBeUndefined();
  });
});

describe('parseTaskInput: dates', () => {
  it.each([
    ['Call Alice fri', 'Call Alice', '2026-12-04'],
    ['Call Alice on fri', 'Call Alice', '2026-12-04'],
    ['Call Alice by friday', 'Call Alice', '2026-12-04'],
    ['Submit report due dec 4', 'Submit report', '2026-12-04'],
    ['Pay invoice tomorrow', 'Pay invoice', '2026-11-29'],
    ['Pay invoice today', 'Pay invoice', '2026-11-28'],
    ['Book flights in 3 days', 'Book flights', '2026-12-01'],
    ['Renew passport next monday', 'Renew passport', '2026-11-30'],
    ['Renew passport in may', 'Renew passport', '2027-05-01'],
    ['Picnic on sat', 'Picnic', '2026-11-28'],
    ['Dentist 4/12', 'Dentist', '2027-04-12']
  ])('%s', (text, title, due) => {
    const p = parse(text);
    expect(p.title).toBe(title);
    expect(p.due).toBe(due);
  });

  it('keeps a time when one is given', () => {
    expect(parse('Standup tomorrow at 9:30am').due).toBe('2026-11-29T09:30');
    expect(parse('Call Bob fri at 3pm').due).toBe('2026-12-04T15:00');
  });

  it('reads numeric dates day-first when asked', () => {
    expect(parse('Dentist 4/12', 'dmy').due).toBe('2026-12-04');
  });

  it('sets a start date with start/from', () => {
    const p = parse('Plan the trip start mon due fri');
    expect(p).toMatchObject({ title: 'Plan the trip', start: '2026-11-30', due: '2026-12-04' });
  });
});

describe('parseTaskInput: repeats', () => {
  it.each([
    ['Water plants daily', 'FREQ=DAILY', '2026-11-28'],
    ['Water plants every day', 'FREQ=DAILY', '2026-11-28'],
    ['Stretch every 2 days', 'FREQ=DAILY;INTERVAL=2', '2026-11-28'],
    ['Team sync weekly on mon', 'FREQ=WEEKLY;BYDAY=MO', '2026-11-30'],
    ['Team sync every mon and thu', 'FREQ=WEEKLY;BYDAY=MO,TH', '2026-11-30'],
    ['Gym every tue, thu and sat', 'FREQ=WEEKLY;BYDAY=TU,TH,SA', '2026-11-28'],
    ['Report every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-11-30'],
    ['One-on-one every other tuesday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '2026-12-01'],
    ['Review every 2 weeks on fri', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', '2026-12-04'],
    ['Pay rent on the first of each month', 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-12-01'],
    ['Pay rent every month on the 1st', 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-12-01'],
    [
      'Invoice on the 31st of each month',
      'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1',
      '2026-11-30'
    ],
    ['Close books on the last day of the month', 'FREQ=MONTHLY;BYMONTHDAY=-1', '2026-11-30'],
    ['Board meeting the first monday of each month', 'FREQ=MONTHLY;BYDAY=1MO', '2026-12-07'],
    // Nov 27 was the last Friday of November (today is Sat Nov 28), so: Dec 25.
    ['Payroll the last friday of the month', 'FREQ=MONTHLY;BYDAY=-1FR', '2026-12-25'],
    [
      'Payroll every month on the last weekday',
      'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
      '2026-11-30'
    ],
    ['Renew domain every year on mar 3', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3', '2027-03-03'],
    ['Renew domain every mar 3', 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3', '2027-03-03']
  ])('%s', (text, rule, due) => {
    const p = parse(text);
    expect(p.repeat).toEqual({ rule, from: 'due' });
    expect(p.due).toBe(due);
    expect(p.title).not.toMatch(/every|each|daily|weekly|month/i);
  });

  it('anchors a plain monthly repeat on its first due date, clamped', () => {
    // Today is the 28th.
    expect(parse('Backup monthly')).toMatchObject({
      due: '2026-11-28',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=28', from: 'due' }
    });
    expect(parse('Backup monthly dec 15')).toMatchObject({
      due: '2026-12-15',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=15', from: 'due' }
    });
    expect(parse('Backup every month due jan 31')).toMatchObject({
      due: '2027-01-31',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1' }
    });
  });

  it('counts from completion with "after done"', () => {
    const p = parse('Water the fern every 3 days after done');
    expect(p).toMatchObject({
      title: 'Water the fern',
      due: '2026-11-28',
      repeat: { rule: 'FREQ=DAILY;INTERVAL=3', from: 'completion' }
    });
  });

  it('takes an end date or a count', () => {
    expect(parse('Physio every mon until jan 31').repeat).toEqual({
      rule: 'FREQ=WEEKLY;BYDAY=MO',
      from: 'due',
      until: '2027-01-31'
    });
    expect(parse('Course every weekday 10 times').repeat).toEqual({
      rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      from: 'due',
      count: 10
    });
  });

  it('uses an explicit date as the first occurrence', () => {
    expect(parse('Team sync every mon starting dec 7')).toMatchObject({
      start: '2026-12-07',
      repeat: { rule: 'FREQ=WEEKLY;BYDAY=MO' }
    });
    expect(parse('Pay rent monthly due jan 1')).toMatchObject({
      due: '2027-01-01',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1' }
    });
  });
});

describe('parseTaskInput: tokens', () => {
  it('reads priority, tags, project and waiting', () => {
    const p = parse('Send the quote !high #sales #followup +"Project X" fri');
    expect(p).toMatchObject({
      title: 'Send the quote',
      priority: 'high',
      tags: ['sales', 'followup'],
      project: 'Project X',
      due: '2026-12-04'
    });
  });

  it.each([
    ['!!!', 'high'],
    ['!!', 'medium'],
    ['!', 'low'],
    ['!med', 'medium'],
    ['!LOW', 'low']
  ])('priority %s is %s', (mark, priority) => {
    expect(parse(`Task ${mark}`).priority).toBe(priority);
  });

  it('does not take punctuation inside words', () => {
    const p = parse('Ship it! Then celebrate');
    expect(p.priority).toBeUndefined();
    expect(p.title).toBe('Ship it! Then celebrate');
  });

  it('reads a bare +Project and waiting-on', () => {
    const p = parse('Quote for the deck +Home #reno waiting on the supplier');
    expect(p).toMatchObject({
      title: 'Quote for the deck',
      project: 'Home',
      tags: ['reno'],
      waitingOn: 'the supplier'
    });
    expect(toNewTaskInput(p)).toMatchObject({ status: 'waiting', waitingOn: 'the supplier' });
  });

  it('reports token positions for highlighting', () => {
    const text = 'Pay rent on the first of each month !high #bills';
    const p = parse(text);
    expect(p.tokens.map((t) => [t.kind, t.text])).toEqual([
      ['repeat', 'on the first of each month'],
      ['priority', '!high'],
      ['tag', '#bills']
    ]);
    for (const t of p.tokens) expect(text.slice(t.start, t.end)).toBe(t.text);
  });

  it('builds create input from the parse', () => {
    expect(toNewTaskInput(parse('Pay rent on the first of each month !high #bills +Home'))).toEqual(
      {
        title: 'Pay rent',
        tags: ['bills'],
        due: '2026-12-01',
        repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1', from: 'due' },
        priority: 'high',
        project: 'Home'
      }
    );
  });
});

describe('field phrases (task detail fields)', () => {
  it('reads a date field, including words that are ambiguous in free text', () => {
    expect(parseDatePhrase('sat', { now: NOW })).toBe('2026-11-28');
    expect(parseDatePhrase('Dec 1, 2026', { now: NOW })).toBe('2026-12-01');
    expect(parseDatePhrase('Feb 10, 2027 14:30', { now: NOW })).toBe('2027-02-10T14:30');
    expect(parseDatePhrase('2026-12-01', { now: NOW })).toBe('2026-12-01');
    expect(parseDatePhrase('next week', { now: NOW })).toBe('2026-12-05');
    expect(parseDatePhrase('', { now: NOW })).toBeNull();
    expect(parseDatePhrase('whenever', { now: NOW })).toBeNull();
  });

  it('reads a repeat field, anchored on the task due date', () => {
    expect(parseRepeatPhrase('monthly', { now: NOW, due: '2026-12-15' })).toEqual({
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=15', from: 'due' },
      due: '2026-12-15'
    });
    expect(parseRepeatPhrase('2 weeks', { now: NOW })?.repeat).toEqual({
      rule: 'FREQ=WEEKLY;INTERVAL=2',
      from: 'due'
    });
    expect(parseRepeatPhrase('every mon and thu', { now: NOW })).toEqual({
      repeat: { rule: 'FREQ=WEEKLY;BYDAY=MO,TH', from: 'due' },
      due: '2026-11-30'
    });
    expect(parseRepeatPhrase('nonsense', { now: NOW })).toBeNull();
  });

  it.each([
    'Daily',
    'Weekly on Mon',
    'Every 2 weeks on Mon and Thu',
    'Every weekday',
    'Monthly on the 1st',
    'Monthly on the last day',
    'Monthly on the first Monday',
    'Monthly on the last weekday',
    'Every 3 months on the 15th',
    'Yearly on Mar 3',
    'Every 3 days after done'
  ])('reads its own label back: %s', (label) => {
    expect(parseRepeatPhrase(label, { now: NOW, due: '2026-12-01' })).not.toBeNull();
  });
});

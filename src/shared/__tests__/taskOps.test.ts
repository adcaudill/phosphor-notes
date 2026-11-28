import { describe, it, expect } from 'vitest';
import {
  addComment,
  applyTaskPatch,
  completeTask,
  createTaskRecord,
  deleteComment,
  editComment,
  setStatus,
  skipOccurrence
} from '../taskOps';
import { monthlyOnDayRule } from '../taskRepeat';

const ID = 'k3f9a2xq';
const at = (iso: string): Date => new Date(iso); // local time

describe('createTaskRecord', () => {
  it('fills in timestamps, a created event, and clean tags', () => {
    const t = createTaskRecord(
      { title: '  Pay rent ', tags: ['#bills', 'bills', ' home '], project: ' Home ' },
      ID,
      at('2026-11-28T09:12:00')
    );
    expect(t).toMatchObject({
      id: ID,
      title: 'Pay rent',
      status: 'todo',
      tags: ['bills', 'home'],
      project: 'Home',
      created: '2026-11-28T09:12:00',
      updated: '2026-11-28T09:12:00',
      log: [{ at: '2026-11-28T09:12:00', type: 'created' }]
    });
  });

  it('rejects invalid input', () => {
    expect(() => createTaskRecord({ title: ' ' }, ID)).toThrow('title is required');
    expect(() => createTaskRecord({ title: 'x', due: 'friday' }, ID)).toThrow('invalid due');
  });
});

describe('completeTask', () => {
  it('marks a one-off task done', () => {
    const t = createTaskRecord(
      { title: 'File taxes', due: '2026-04-15' },
      ID,
      at('2026-04-01T08:00:00')
    );
    const done = completeTask(t, at('2026-04-10T17:30:00'));
    expect(done.status).toBe('done');
    expect(done.completed).toBe('2026-04-10T17:30:00');
    expect(done.log.at(-1)).toEqual({
      at: '2026-04-10T17:30:00',
      type: 'completed',
      occurrence: '2026-04-15'
    });
  });

  it('moves a repeating task to its next occurrence', () => {
    const t = createTaskRecord(
      {
        title: 'Pay rent',
        due: '2026-12-01',
        start: '2026-11-28',
        repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1', from: 'due' },
        checklist: [
          { text: 'Transfer', done: true },
          { text: 'Pay', done: true }
        ]
      },
      ID,
      at('2026-11-20T08:00:00')
    );
    const next = completeTask(t, at('2026-11-30T10:00:00'));
    expect(next.status).toBe('todo');
    expect(next.due).toBe('2027-01-01');
    expect(next.start).toBe('2026-12-29'); // same 3-day lead
    expect(next.checklist.every((c) => !c.done)).toBe(true);
    expect(next.completed).toBe('2026-11-30T10:00:00');
    expect(next.log.at(-1)).toMatchObject({ type: 'completed', occurrence: '2026-12-01' });
  });

  it('keeps month-end repeats on the last day of the month', () => {
    const t = createTaskRecord(
      { title: 'Invoice', due: '2026-01-31', repeat: { rule: monthlyOnDayRule(31), from: 'due' } },
      ID,
      at('2026-01-01T08:00:00')
    );
    const feb = completeTask(t, at('2026-01-31T09:00:00'));
    expect(feb.due).toBe('2026-02-28');
    const mar = completeTask(feb, at('2026-02-28T09:00:00'));
    expect(mar.due).toBe('2026-03-31');
  });

  it('ends a series on its last counted occurrence', () => {
    const t = createTaskRecord(
      { title: 'Course', due: '2026-11-28', repeat: { rule: 'FREQ=DAILY', from: 'due', count: 2 } },
      ID,
      at('2026-11-27T08:00:00')
    );
    const second = completeTask(t, at('2026-11-28T09:00:00'));
    expect(second).toMatchObject({ status: 'todo', due: '2026-11-29', repeat: { count: 1 } });
    const last = completeTask(second, at('2026-11-29T09:00:00'));
    expect(last.status).toBe('done');
  });
});

describe('skipOccurrence', () => {
  it('moves to the next occurrence without completing', () => {
    const t = createTaskRecord(
      {
        title: 'Standup',
        due: '2026-11-30',
        repeat: { rule: 'FREQ=WEEKLY;BYDAY=MO', from: 'due' }
      },
      ID,
      at('2026-11-27T08:00:00')
    );
    const s = skipOccurrence(t, at('2026-11-27T09:00:00'));
    expect(s.due).toBe('2026-12-07');
    expect(s.status).toBe('todo');
    expect(s.completed).toBeUndefined();
    expect(s.log.at(-1)).toMatchObject({ type: 'skipped', occurrence: '2026-11-30' });
  });

  it('refuses for a task that does not repeat', () => {
    const t = createTaskRecord({ title: 'Once', due: '2026-11-30' }, ID);
    expect(() => skipOccurrence(t)).toThrow('repeating');
  });
});

describe('setStatus and applyTaskPatch', () => {
  const base = (): ReturnType<typeof createTaskRecord> =>
    createTaskRecord({ title: 'Call Alice', due: '2026-12-01' }, ID, at('2026-11-27T08:00:00'));

  it('logs status changes and clears the completion time when reopened', () => {
    const done = setStatus(base(), 'done', at('2026-11-28T10:00:00'));
    expect(done.completed).toBe('2026-11-28T10:00:00');
    const reopened = setStatus(done, 'todo', at('2026-11-28T11:00:00'));
    expect(reopened.completed).toBeUndefined();
    expect(reopened.log.at(-1)).toEqual({
      at: '2026-11-28T11:00:00',
      type: 'status',
      from: 'done',
      to: 'todo'
    });
  });

  it('applies field changes, clears with null, and logs a reschedule', () => {
    const p = applyTaskPatch(
      base(),
      {
        title: 'Call Alice back',
        due: '2026-12-03',
        priority: 'high',
        tags: ['phone'],
        project: ''
      },
      at('2026-11-28T09:00:00')
    );
    expect(p).toMatchObject({
      title: 'Call Alice back',
      due: '2026-12-03',
      priority: 'high',
      tags: ['phone']
    });
    expect(p.log.at(-1)).toEqual({
      at: '2026-11-28T09:00:00',
      type: 'rescheduled',
      from: '2026-12-01',
      to: '2026-12-03'
    });
    const cleared = applyTaskPatch(p, { priority: null, due: null }, at('2026-11-28T09:05:00'));
    expect(cleared.priority).toBeUndefined();
    expect(cleared.due).toBeUndefined();
    expect(cleared.updated).toBe('2026-11-28T09:05:00');
  });

  it('validates the result', () => {
    expect(() => applyTaskPatch(base(), { due: '2026-02-30' })).toThrow('invalid due');
  });
});

describe('comments', () => {
  it('adds, edits and deletes comments', () => {
    let t = createTaskRecord({ title: 'x' }, ID, at('2026-11-27T08:00:00'));
    t = addComment(t, ' Waiting on the quote ', at('2026-11-27T09:00:00'));
    expect(t.log.at(-1)).toEqual({
      at: '2026-11-27T09:00:00',
      type: 'comment',
      text: 'Waiting on the quote'
    });
    t = editComment(t, '2026-11-27T09:00:00', 'Quote received', at('2026-11-27T10:00:00'));
    expect(t.log.at(-1)).toMatchObject({ text: 'Quote received', edited: '2026-11-27T10:00:00' });
    t = deleteComment(t, '2026-11-27T09:00:00', at('2026-11-27T11:00:00'));
    expect(t.log.some((e) => e.type === 'comment')).toBe(false);
    expect(() => addComment(t, '  ')).toThrow('needs some text');
  });
});

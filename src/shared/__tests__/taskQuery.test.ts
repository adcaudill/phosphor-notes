import { describe, it, expect } from 'vitest';
import {
  groupTasks,
  inView,
  parseTaskFilter,
  sortTasks,
  viewCounts,
  type TaskViewId
} from '../taskQuery';
import type { TaskSummary } from '../taskViews';

const TODAY = '2026-11-28'; // a Saturday

let n = 0;
function task(fields: Partial<TaskSummary> & { title: string }): TaskSummary {
  n += 1;
  return {
    id: `t${n}`,
    status: 'todo',
    tags: [],
    checklist: [],
    hasNotes: false,
    commentCount: 0,
    linkCount: 0,
    linkedNotes: [],
    created: `2026-11-0${(n % 9) + 1}T09:00:00`,
    updated: `2026-11-0${(n % 9) + 1}T09:00:00`,
    ...fields
  };
}

const T = {
  inbox: task({ title: 'Unsorted idea' }),
  overdue: task({ title: 'Overdue bill', due: '2026-11-20', priority: 'high', tags: ['bills'] }),
  today: task({ title: 'Call Alice', due: '2026-11-28T15:00', project: 'Work' }),
  startsToday: task({ title: 'Start the report', start: '2026-11-28', project: 'Work' }),
  upcoming: task({
    title: 'Renew domain',
    due: '2026-12-03',
    repeat: { rule: 'FREQ=YEARLY', from: 'due' }
  }),
  later: task({ title: 'Plan trip', due: '2027-03-01' }),
  anytime: task({ title: 'Read the handbook', project: 'Work', hasNotes: true }),
  waiting: task({
    title: 'Quote from supplier',
    status: 'waiting',
    waitingOn: 'Bob',
    linkCount: 2
  }),
  scheduled: task({ title: 'Review taxes', start: '2027-01-15', due: '2027-04-15' }),
  done: task({ title: 'Book the room', status: 'done', completed: '2026-11-27T10:00:00' }),
  cancelled: task({ title: 'Old plan', status: 'cancelled', updated: '2026-11-10T09:00:00' })
};
const ALL = Object.values(T);

function ids(view: TaskViewId): string[] {
  return ALL.filter((t) => inView(t, view, TODAY)).map((t) => t.title);
}

describe('views', () => {
  it.each<[TaskViewId, string[]]>([
    ['inbox', ['Unsorted idea']],
    ['today', ['Overdue bill', 'Call Alice', 'Start the report']],
    ['upcoming', ['Renew domain']],
    ['anytime', ['Start the report', 'Read the handbook']],
    ['waiting', ['Quote from supplier']],
    ['scheduled', ['Review taxes']],
    ['logbook', ['Book the room', 'Old plan']]
  ])('%s', (view, expected) => {
    expect(ids(view)).toEqual(expected);
  });

  it('counts each view', () => {
    expect(viewCounts(ALL, TODAY)).toMatchObject({
      inbox: 1,
      today: 3,
      waiting: 1,
      logbook: 2,
      all: ALL.length
    });
  });
});

describe('parseTaskFilter', () => {
  const run = (q: string, links?: Record<string, string[]>): string[] => {
    const f = parseTaskFilter(q);
    return ALL.map((t) => ({ ...t, linkedNotes: links?.[t.id] ?? t.linkedNotes }))
      .filter((t) => f.test(t, { today: TODAY }))
      .map((t) => t.title);
  };

  it.each([
    ['status:waiting', ['Quote from supplier']],
    ['status:done', ['Book the room']],
    ['priority:high', ['Overdue bill']],
    ['due:overdue', ['Overdue bill']],
    ['due:today', ['Call Alice']],
    ['due:<7d', ['Overdue bill', 'Call Alice', 'Renew domain']],
    ['due:>2027-01-01', ['Plan trip', 'Review taxes']],
    ['start:>today', ['Review taxes']],
    ['#bills', ['Overdue bill']],
    ['+work', ['Call Alice', 'Start the report', 'Read the handbook']],
    ['has:notes', ['Read the handbook']],
    ['repeat:yes', ['Renew domain']],
    ['linked:yes', ['Quote from supplier']],
    ['completed:yesterday', ['Book the room']],
    ['+work due:today', ['Call Alice']]
  ])('%s', (q, expected) => {
    expect(run(q)).toEqual(expected);
  });

  it('matches in:"Note" against where a task is linked', () => {
    const links = { [T.today.id]: ['Weekly Review.md'], [T.later.id]: ['Other.md'] };
    expect(run('in:"Weekly Review"', links)).toEqual(['Call Alice']);
  });

  it('keeps free text for the full-text index, and reports the filter terms', () => {
    const f = parseTaskFilter('rent +"Home Office" due:week "exact phrase" status:nonsense');
    expect(f.terms).toEqual(['+"Home Office"', 'due:week']);
    expect(f.text).toBe('rent exact phrase status:nonsense');
  });
});

describe('sorting and grouping', () => {
  it('sorts by due date (undated last), then priority', () => {
    const open = ALL.filter((t) => t.status === 'todo');
    expect(
      sortTasks(open, 'due')
        .map((t) => t.title)
        .slice(0, 4)
    ).toEqual(['Overdue bill', 'Call Alice', 'Renew domain', 'Plan trip']);
  });

  it('groups by due date into readable sections', () => {
    const open = sortTasks(
      ALL.filter((t) => t.status === 'todo'),
      'due'
    );
    expect(groupTasks(open, 'due', TODAY).map((g) => [g.label, g.tasks.length])).toEqual([
      ['Overdue', 1],
      ['Today', 1],
      ['This week', 1],
      ['Later', 2],
      ['No date', 3]
    ]);
  });

  it('groups upcoming by day and the logbook by completion day', () => {
    expect(groupTasks([T.upcoming], 'due', TODAY, 'upcoming')[0].label).toBe('Thursday, Dec 3');
    const log = sortTasks([T.cancelled, T.done], 'due', 'logbook');
    expect(groupTasks(log, 'none', TODAY, 'logbook').map((g) => g.label)).toEqual([
      'Yesterday',
      'Tuesday, Nov 10'
    ]);
  });

  it('puts a task with several tags under each tag', () => {
    const t = task({ title: 'Both', tags: ['a', 'b'] });
    expect(groupTasks([t, T.inbox], 'tag', TODAY).map((g) => [g.label, g.tasks.length])).toEqual([
      ['#a', 1],
      ['#b', 1],
      ['No tags', 1]
    ]);
  });
});

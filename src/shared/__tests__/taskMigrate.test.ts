import { describe, it, expect } from 'vitest';
import {
  applyNoteMigration,
  isConvertibleTaskLine,
  planNoteMigration,
  withMigratedHistory
} from '../taskMigrate';
import { createTaskRecord } from '../taskOps';

const TODAY = '2026-11-28';
const NOW = '2026-11-28T09:00:00';

describe('isConvertibleTaskLine', () => {
  it.each([
    ['- [ ] Pay rent 📅 2026-12-01', true],
    ['- [x] Paid ✓ 2026-11-01 09:00:00', true],
    ['    - [ ] Call @due(2026-12-02)', true],
    ['- [ ] Submit DEADLINE: <2026-12-10 Thu>', true],
    ['- [ ] Imported @start(2026-12-01) @status(waiting)', true],
    ['- [ ] Milk', false],
    ['- Plain bullet 📅 2026-12-01', false]
  ])('%s', (line, expected) => {
    expect(isConvertibleTaskLine(line)).toBe(expected);
  });
});

describe('planNoteMigration', () => {
  it('turns task lines with metadata into task fields, leaving checklist items alone', () => {
    const doc = [
      '- Groceries',
      '    - [ ] Milk',
      '- [ ] Renew the subscription 📅 2026-12-15 🔁 +1y 🔺',
      '    - [/] Draft the agenda @due(2026-12-01) 🔼',
      '- [x] Book the room 📅 2026-11-20 ✓ 2026-11-19 16:30:00'
    ].join('\n');
    const plan = planNoteMigration(doc, TODAY, NOW);
    expect(plan.removed).toEqual([]);
    expect(plan.tasks.map((t) => [t.line, t.indent, t.input])).toEqual([
      [
        2,
        '',
        {
          title: 'Renew the subscription',
          status: 'todo',
          due: '2026-12-15',
          priority: 'high',
          repeat: { rule: 'FREQ=YEARLY', from: 'due' }
        }
      ],
      [
        3,
        '    ',
        { title: 'Draft the agenda', status: 'doing', due: '2026-12-01', priority: 'medium' }
      ],
      [4, '', { title: 'Book the room', status: 'done', due: '2026-11-20' }]
    ]);
    expect(plan.tasks[2].completed).toBe('2026-11-19T16:30:00');
    expect(plan.tasks[2].log).toEqual([
      { at: '2026-11-19T16:30:00', type: 'completed', occurrence: '2026-11-20' }
    ]);
  });

  it('reads Org-mode and importer markers', () => {
    const plan = planNoteMigration(
      [
        '- [ ] Submit invoice DEADLINE: <2026-12-10 Thu> SCHEDULED: <2026-12-01 Tue>',
        '- [ ] Hear back @due(2026-12-05) @status(waiting)',
        '- [x] Dropped plan @due(2026-10-01) @status(cancelled)',
        '- [ ] Prepare deck @start(2026-12-02) @due(2026-12-09)'
      ].join('\n'),
      TODAY,
      NOW
    );
    expect(plan.tasks.map((t) => t.input)).toEqual([
      { title: 'Submit invoice', status: 'todo', due: '2026-12-10', start: '2026-12-01' },
      { title: 'Hear back', status: 'waiting', due: '2026-12-05' },
      { title: 'Dropped plan', status: 'cancelled', due: '2026-10-01' },
      { title: 'Prepare deck', status: 'todo', due: '2026-12-09', start: '2026-12-02' }
    ]);
  });

  it('keeps month-end repeats on the month end', () => {
    const plan = planNoteMigration('- [ ] Invoice 📅 2027-01-31 🔁 +1m', TODAY, NOW);
    expect(plan.tasks[0].input.repeat).toEqual({
      rule: 'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1',
      from: 'due'
    });
  });

  it('notes sub-day repeats it cannot keep', () => {
    const plan = planNoteMigration('- [ ] Stretch @due(2026-11-30) @repeat(1h)', TODAY, NOW);
    expect(plan.tasks[0].input.repeat).toBeUndefined();
    expect(plan.tasks[0].log[0]).toMatchObject({ type: 'comment' });
    expect(String(plan.tasks[0].log[0].text)).toContain('every 1 hours');
  });

  it('folds the history lines of a repeating task into the open one', () => {
    const doc = [
      '- [x] Water plants 📅 2026-11-14 🔁 +1w ✓ 2026-11-14 08:00:00',
      '- [x] Water plants 📅 2026-11-21 🔁 +1w ✓ 2026-11-22 09:30:00',
      '- [ ] Water plants 📅 2026-11-28 🔁 +1w',
      '- [x] Something else 📅 2026-11-21 ✓ 2026-11-21 10:00:00'
    ].join('\n');
    const plan = planNoteMigration(doc, TODAY, NOW);
    expect(plan.tasks.map((t) => t.input.title)).toEqual(['Water plants', 'Something else']);
    expect(plan.removed.map((r) => r.line)).toEqual([0, 1]);
    expect(plan.tasks[0].log).toEqual([
      { at: '2026-11-14T08:00:00', type: 'completed', occurrence: '2026-11-14' },
      { at: '2026-11-22T09:30:00', type: 'completed', occurrence: '2026-11-21' }
    ]);
  });
});

describe('applyNoteMigration', () => {
  const doc = [
    '- Weekly',
    '    - [x] Water plants 📅 2026-11-21 🔁 +1w ✓ 2026-11-22 09:30:00',
    '    - [ ] Water plants 📅 2026-11-28 🔁 +1w',
    '    - [ ] Milk',
    ''
  ].join('\n');

  it('replaces converted lines with links and removes folded history lines', () => {
    const plan = planNoteMigration(doc, TODAY, NOW);
    expect(applyNoteMigration(doc, plan, [{ id: 'k3f9a2xq', title: 'Water plants' }])).toBe(
      ['- Weekly', '    - [[_task:k3f9a2xq|Water plants]]', '    - [ ] Milk', ''].join('\n')
    );
  });

  it('refuses if a line changed since it was planned', () => {
    const plan = planNoteMigration(doc, TODAY, NOW);
    const edited = doc.replace('Water plants 📅 2026-11-28', 'Water the plants 📅 2026-11-28');
    expect(() => applyNoteMigration(edited, plan, [{ id: 'k3f9a2xq', title: 'x' }])).toThrow(
      'changed'
    );
  });
});

describe('withMigratedHistory', () => {
  it('keeps the completion time and folded completions, noting the source', () => {
    const plan = planNoteMigration(
      '- [x] Book the room 📅 2026-11-20 ✓ 2026-11-19 16:30:00',
      TODAY,
      NOW
    );
    const record = createTaskRecord(plan.tasks[0].input, 'k3f9a2xq', new Date(2026, 10, 28, 9));
    const migrated = withMigratedHistory(record, plan.tasks[0], 'Daily/2026-11-19.md');
    expect(migrated.completed).toBe('2026-11-19T16:30:00');
    expect(migrated.log).toEqual([
      { at: '2026-11-28T09:00:00', type: 'created', source: 'Daily/2026-11-19.md' },
      { at: '2026-11-19T16:30:00', type: 'completed', occurrence: '2026-11-20' }
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { convertLogseqTasks } from '../worker/importer';
import { planNoteMigration } from '../../shared/taskMigrate';

const convert = (lines: string[]): string => convertLogseqTasks(lines.join('\n'));

describe('convertLogseqTasks', () => {
  it.each([
    [
      'a .+ repeater (from completion in Logseq)',
      ['- TODO Water plants', '  SCHEDULED: <2026-08-02 Sun .+1w>'],
      '- [ ] Water plants @due(2026-08-02) @repeat(1w)'
    ],
    [
      'a ++ repeater',
      ['- TODO Water plants', '  SCHEDULED: <2026-08-02 Sun ++1w>'],
      '- [ ] Water plants @due(2026-08-02) @repeat(1w)'
    ],
    [
      'a + repeater',
      ['- TODO Water plants', '  SCHEDULED: <2026-08-02 Sun +1m>'],
      '- [ ] Water plants @due(2026-08-02) @repeat(1m)'
    ],
    [
      'a time in the date',
      ['- TODO Standup', '  SCHEDULED: <2026-08-02 Sun 09:30>'],
      '- [ ] Standup @due(2026-08-02)'
    ],
    [
      'a nested task',
      ['- Project', '  - TODO Nested thing', '    SCHEDULED: <2026-08-02 Sun>'],
      '- Project\n  - [ ] Nested thing @due(2026-08-02)'
    ],
    [
      'both SCHEDULED and DEADLINE',
      ['- TODO Both', '  SCHEDULED: <2026-08-02 Sun>', '  DEADLINE: <2026-08-09 Sun>'],
      '- [ ] Both @due(2026-08-09) @start(2026-08-02)'
    ],
    ['WAITING', ['- WAITING On reply'], '- [ ] On reply @status(waiting)'],
    ['CANCELLED', ['- CANCELLED Old plan'], '- [x] Old plan @status(cancelled)'],
    ['NOW and DONE', ['- NOW Writing', '- DONE Shipped'], '- [/] Writing\n- [x] Shipped'],
    [
      'TODO in the middle of a line',
      ['- Notes - TODO is a word here'],
      '- Notes - TODO is a word here'
    ],
    [
      'an inline DEADLINE',
      ['- TODO Submit DEADLINE: <2026-12-10 Thu> report'],
      '- [ ] Submit report @due(2026-12-10)'
    ],
    ['a stray date line', ['- Heading', 'SCHEDULED: <2026-08-02 Sun>'], '- Heading']
  ])('%s', (_label, input, expected) => {
    expect(convert(input)).toBe(expected);
  });

  it('produces lines the task conversion understands', () => {
    const out = convert([
      '- TODO Both',
      '  SCHEDULED: <2026-08-02 Sun .+1w>',
      '  DEADLINE: <2026-08-09 Sun>',
      '- WAITING Quote @due(2026-09-01)'
    ]);
    const plan = planNoteMigration(out, '2026-07-01', '2026-07-01T09:00:00');
    expect(plan.tasks.map((t) => t.input)).toEqual([
      {
        title: 'Both',
        status: 'todo',
        due: '2026-08-09',
        start: '2026-08-02',
        repeat: { rule: 'FREQ=WEEKLY', from: 'due' }
      },
      { title: 'Quote', status: 'waiting', due: '2026-09-01' }
    ]);
  });
});

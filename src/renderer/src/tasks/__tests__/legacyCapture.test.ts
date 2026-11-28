import { describe, it, expect } from 'vitest';
import { parseTaskLine } from '../../../../shared/tasks';
import { parseTaskInput, toNewTaskInput } from '../../../../shared/taskParse';
import { legacyTaskAsCaptureText } from '../legacyCapture';

const NOW = new Date(2026, 10, 28, 9, 0, 0);

/** Inline checkbox line -> capture text -> parsed task fields. */
function convert(line: string): ReturnType<typeof toNewTaskInput> & { text: string } {
  const parsed = parseTaskLine(line);
  if (!parsed) throw new Error('not a task line');
  const text = legacyTaskAsCaptureText(parsed);
  return { text, ...toNewTaskInput(parseTaskInput(text, { now: NOW })) };
}

describe('converting inline checkbox tasks', () => {
  it('keeps the text, due date, repeat and priority', () => {
    expect(convert('- [ ] Renew the subscription 📅 2026-12-15 🔁 +1y 🔺')).toEqual({
      text: 'Renew the subscription due 2026-12-15 every year !high',
      title: 'Renew the subscription',
      tags: [],
      due: '2026-12-15',
      repeat: { rule: 'FREQ=YEARLY', from: 'due' },
      priority: 'high'
    });
  });

  it('reads the older @due/@repeat forms the same way', () => {
    expect(convert('- [ ] Pay rent @due(2026-12-01) @repeat(1m)')).toMatchObject({
      title: 'Pay rent',
      due: '2026-12-01',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1', from: 'due' }
    });
  });

  it('keeps a month-end repeat on the month end', () => {
    expect(convert('- [ ] Invoice 📅 2027-01-31 🔁 +1m')).toMatchObject({
      due: '2027-01-31',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1' }
    });
  });

  it('converts a plain checkbox to a plain task', () => {
    expect(convert('    - [ ] Call Alice')).toEqual({
      text: 'Call Alice',
      title: 'Call Alice',
      tags: []
    });
  });

  it('drops sub-day repeats it cannot represent', () => {
    expect(convert('- [ ] Stretch @due(2026-11-30) @repeat(1h) 🔽')).toEqual({
      text: 'Stretch due 2026-11-30 !low',
      title: 'Stretch',
      tags: [],
      due: '2026-11-30',
      priority: 'low'
    });
  });
});

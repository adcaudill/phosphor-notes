import { describe, it, expect } from 'vitest';
import {
  generateTaskId,
  isTaskFilePath,
  isValidTaskId,
  parseTaskFile,
  serializeTaskFile,
  taskFilePath,
  taskIdFromPath,
  type TaskRecord
} from '../taskRecord';

const ID = 'k3f9a2xq';

const SAMPLE = `---
id: k3f9a2xq
title: Pay rent
status: todo
priority: high
due: 2026-12-01
start: 2026-11-28
repeat:
  rule: FREQ=MONTHLY;BYMONTHDAY=1
  from: due
project: Home
tags: [ bills ]
created: 2026-11-28T09:12:00
updated: 2026-11-28T09:12:00
checklist:
  - { text: Transfer funds, done: true }
  - { text: Send payment, done: false }
log:
  - { at: 2026-11-28T09:12:00, type: created }
  - { at: 2026-11-15T17:02:00, type: comment, text: "Confirmed: new account details." }
---
Account details are in [[Home/Lease]].

Ask about the parking fee.
`;

function parsed(text: string, id = ID): TaskRecord {
  const r = parseTaskFile(text, id);
  if (!r.ok) throw new Error(r.error);
  return r.task;
}

describe('task ids and paths', () => {
  it('generates valid, varied ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateTaskId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isValidTaskId(id)).toBe(true);
  });

  it('rejects ids with ambiguous or unsupported characters', () => {
    expect(isValidTaskId('k3f9a2xq')).toBe(true);
    expect(isValidTaskId('k3f9a2x0')).toBe(false); // 0
    expect(isValidTaskId('k3f9a2xl')).toBe(false); // l
    expect(isValidTaskId('K3F9A2XQ')).toBe(false);
    expect(isValidTaskId('k3f9a2x')).toBe(false);
  });

  it('maps ids to paths and back', () => {
    expect(taskFilePath(ID)).toBe('_tasks/k3f9a2xq.md');
    expect(taskIdFromPath('_tasks/k3f9a2xq.md')).toBe(ID);
    expect(taskIdFromPath('_tasks\\k3f9a2xq.md')).toBe(ID);
    expect(taskIdFromPath('_tasks/notes.md')).toBeNull();
    expect(taskIdFromPath('People/k3f9a2xq.md')).toBeNull();
  });

  it('recognizes paths inside the tasks folder', () => {
    expect(isTaskFilePath('_tasks/k3f9a2xq.md')).toBe(true);
    expect(isTaskFilePath('_tasks')).toBe(true);
    expect(isTaskFilePath('./_tasks/x.md')).toBe(true);
    expect(isTaskFilePath('_tasks.md')).toBe(false);
    expect(isTaskFilePath('Projects/_tasks/x.md')).toBe(false);
  });
});

describe('parseTaskFile', () => {
  it('reads every field', () => {
    const t = parsed(SAMPLE);
    expect(t).toMatchObject({
      id: ID,
      title: 'Pay rent',
      status: 'todo',
      priority: 'high',
      due: '2026-12-01',
      start: '2026-11-28',
      repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1', from: 'due' },
      project: 'Home',
      tags: ['bills'],
      created: '2026-11-28T09:12:00',
      checklist: [
        { text: 'Transfer funds', done: true },
        { text: 'Send payment', done: false }
      ]
    });
    expect(t.log).toHaveLength(2);
    expect(t.log[1]).toMatchObject({ type: 'comment', text: 'Confirmed: new account details.' });
    expect(t.notes).toBe('Account details are in [[Home/Lease]].\n\nAsk about the parking fee.');
  });

  it('uses the filename id when the field disagrees', () => {
    const t = parsed(SAMPLE.replace('id: k3f9a2xq', 'id: zzzzzzzz'), 'm8d2c7wa');
    expect(t.id).toBe('m8d2c7wa');
  });

  it('keeps unknown fields', () => {
    const t = parsed(SAMPLE.replace('status: todo', 'status: todo\nestimate: 2h\ncustom:\n  a: 1'));
    expect(t.extra).toEqual({ estimate: '2h', custom: { a: 1 } });
    const again = parsed(serializeTaskFile(t));
    expect(again.extra).toEqual({ estimate: '2h', custom: { a: 1 } });
  });

  it('reads typed scalars as text and a single tag as a list', () => {
    const t = parsed('---\ntitle: 2026\ntags: urgent\nproject: 42\n---\n');
    expect(t.title).toBe('2026');
    expect(t.tags).toEqual(['urgent']);
    expect(t.project).toBe('42');
    expect(t.status).toBe('todo'); // default
  });

  it('accepts a due time and CRLF line endings', () => {
    const t = parsed('---\r\ntitle: Call\r\ndue: 2026-12-01T14:30\r\n---\r\nNotes\r\n');
    expect(t.due).toBe('2026-12-01T14:30');
    expect(t.notes).toBe('Notes');
  });

  it.each([
    ['no frontmatter', 'title: x', 'missing frontmatter'],
    ['unclosed frontmatter', '---\ntitle: x\n', 'not closed'],
    ['bad yaml', '---\ntitle: [x\n---\n', 'not valid YAML'],
    ['no title', '---\nstatus: todo\n---\n', 'title is required'],
    ['bad status', '---\ntitle: x\nstatus: later\n---\n', 'status must be'],
    ['bad priority', '---\ntitle: x\npriority: urgent\n---\n', 'priority must be'],
    ['impossible date', '---\ntitle: x\ndue: 2026-02-30\n---\n', 'due must be'],
    ['bad repeat rule', '---\ntitle: x\nrepeat:\n  rule: FREQ=HOURLY\n---\n', 'repeat.rule'],
    ['rule with COUNT', '---\ntitle: x\nrepeat:\n  rule: FREQ=DAILY;COUNT=3\n---\n', 'repeat.rule'],
    [
      'bad repeat from',
      '---\ntitle: x\nrepeat:\n  rule: FREQ=DAILY\n  from: later\n---\n',
      'repeat.from'
    ],
    ['bad timestamp', '---\ntitle: x\ncreated: yesterday\n---\n', 'created must be'],
    ['list frontmatter', '---\n- a\n---\n', 'set of fields']
  ])('explains a problem: %s', (_label, text, message) => {
    const r = parseTaskFile(text, ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe('serializeTaskFile', () => {
  it('round-trips without changes once canonical', () => {
    const once = serializeTaskFile(parsed(SAMPLE));
    const twice = serializeTaskFile(parsed(once));
    expect(twice).toBe(once);
  });

  it('writes the canonical layout', () => {
    const text = serializeTaskFile(parsed(SAMPLE));
    expect(text).toBe(`---
id: k3f9a2xq
title: Pay rent
status: todo
priority: high
due: 2026-12-01
start: 2026-11-28
repeat:
  rule: FREQ=MONTHLY;BYMONTHDAY=1
  from: due
project: Home
tags: [ bills ]
created: 2026-11-28T09:12:00
updated: 2026-11-28T09:12:00
checklist:
  - { text: Transfer funds, done: true }
  - { text: Send payment, done: false }
log:
  - { at: 2026-11-28T09:12:00, type: created }
  - { at: 2026-11-15T17:02:00, type: comment, text: "Confirmed: new account details." }
---
Account details are in [[Home/Lease]].

Ask about the parking fee.
`);
  });

  it('leaves out empty optional fields and an empty body', () => {
    const t = parsed('---\ntitle: Simple\n---\n');
    expect(serializeTaskFile(t)).toBe(`---\nid: ${ID}\ntitle: Simple\nstatus: todo\n---\n`);
  });

  it('quotes text that YAML would otherwise misread', () => {
    const t = parsed('---\ntitle: x\n---\n');
    t.title = 'Ask: why #1? - [x] yes';
    t.tags = ['true', '2026'];
    t.log = [{ at: '2026-11-28T09:00:00', type: 'comment', text: 'Line one\nLine two' }];
    const again = parsed(serializeTaskFile(t));
    expect(again.title).toBe(t.title);
    expect(again.tags).toEqual(['true', '2026']);
    expect(again.log[0].text).toBe('Line one\nLine two');
  });

  it('refuses to write an invalid record', () => {
    const t = parsed('---\ntitle: x\n---\n');
    expect(() => serializeTaskFile({ ...t, title: 'two\nlines' })).toThrow('single line');
    expect(() => serializeTaskFile({ ...t, due: '2026-13-01' })).toThrow('invalid due');
    expect(() => serializeTaskFile({ ...t, id: 'BAD' })).toThrow('invalid task id');
  });
});

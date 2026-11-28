import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import { clearTaskIndex } from '../taskIndex';
import { loadAllTasks } from '../taskStore';
import { listVersions } from '../noteHistory';
import { previewMigration, runMigration } from '../taskMigration';
import * as vaultWriter from '../vaultWriter';

const NOW = new Date(2026, 10, 28, 9, 0, 0);

describe('taskMigration', () => {
  let vault: string;
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf-8');

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-taskmigration-test-'));
    vaultState.setVaultPath(null);
    clearTaskIndex();
    write(
      'Daily/2026-11-28.md',
      [
        '---',
        'mode: outliner',
        '---',
        '- Weekly',
        '    - [x] Water plants 📅 2026-11-21 🔁 +1w ✓ 2026-11-22 09:30:00',
        '    - [ ] Water plants 📅 2026-11-28 🔁 +1w',
        '    - [ ] Milk',
        '- [ ] Renew the subscription 📅 2026-12-15 🔁 +1y 🔺',
        ''
      ].join('\n')
    );
    write('Projects/Home.md', '- [ ] Call the plumber @due(2026-12-02)\n- plain bullet\n');
    write('Plain.md', '- [ ] Just a checklist\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearTaskIndex();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('previews without writing anything', async () => {
    const before = read('Daily/2026-11-28.md');
    const preview = await previewMigration(vault, { now: NOW });
    expect(preview.tasks).toBe(3);
    expect(preview.notes).toEqual([
      {
        note: 'Daily/2026-11-28.md',
        tasks: 2,
        folded: 1,
        samples: ['Water plants', 'Renew the subscription']
      },
      { note: 'Projects/Home.md', tasks: 1, folded: 0, samples: ['Call the plumber'] }
    ]);
    expect(read('Daily/2026-11-28.md')).toBe(before);
    expect(fs.existsSync(path.join(vault, '_tasks'))).toBe(false);
  });

  it('converts the vault: task files, links in place, history grouped by one operation', async () => {
    const result = await runMigration(vault, {
      expectedGeneration: vaultState.getGeneration(),
      now: NOW
    });
    expect(result.tasksCreated).toBe(3);
    expect(result.notesChanged.sort()).toEqual(['Daily/2026-11-28.md', 'Projects/Home.md']);
    expect(result.skipped).toEqual([]);

    const { tasks } = await loadAllTasks(vault);
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
    expect(byTitle['Water plants']).toMatchObject({
      due: '2026-11-28',
      repeat: { rule: 'FREQ=WEEKLY', from: 'due' },
      status: 'todo'
    });
    expect(byTitle['Water plants'].log.map((e) => e.type)).toEqual(['created', 'completed']);
    expect(byTitle['Call the plumber'].due).toBe('2026-12-02');

    const daily = read('Daily/2026-11-28.md');
    expect(daily).toBe(
      [
        '---',
        'mode: outliner',
        '---',
        '- Weekly',
        `    - [[_task:${byTitle['Water plants'].id}|Water plants]]`,
        '    - [ ] Milk',
        `- [[_task:${byTitle['Renew the subscription'].id}|Renew the subscription]]`,
        ''
      ].join('\n')
    );
    expect(read('Plain.md')).toBe('- [ ] Just a checklist\n');

    const versions = await listVersions(vault, {});
    const ops = new Set(versions.filter((v) => v.tool === 'task-conversion').map((v) => v.opId));
    expect(ops).toEqual(new Set([result.opId]));
  });

  it('converts only the notes asked for', async () => {
    const result = await runMigration(vault, {
      notes: ['Projects/Home.md'],
      expectedGeneration: vaultState.getGeneration(),
      now: NOW
    });
    expect(result.notesChanged).toEqual(['Projects/Home.md']);
    expect(read('Daily/2026-11-28.md')).toContain('🔁 +1w');
  });

  it('rolls a note back if it changes while being converted', async () => {
    const real = vaultWriter.modifyNote;
    vi.spyOn(vaultWriter, 'modifyNote').mockImplementation(async (vp, rel, fn, o) => {
      if (rel === 'Projects/Home.md') {
        fs.writeFileSync(path.join(vault, rel), '- [ ] Call the plumber @due(2026-12-03)\n');
      }
      return real(vp, rel, fn, o);
    });
    const result = await runMigration(vault, {
      expectedGeneration: vaultState.getGeneration(),
      now: NOW
    });
    expect(result.skipped.map((s) => s.note)).toEqual(['Projects/Home.md']);
    expect(read('Projects/Home.md')).toBe('- [ ] Call the plumber @due(2026-12-03)\n');
    const { tasks } = await loadAllTasks(vault);
    expect(tasks.map((t) => t.title).sort()).toEqual(['Renew the subscription', 'Water plants']);
  });
});

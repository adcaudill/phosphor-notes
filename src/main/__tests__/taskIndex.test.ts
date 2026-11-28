import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import { createTask } from '../taskStore';
import {
  clearTaskIndex,
  forgetTaskFile,
  getTaskDetail,
  getTaskLinks,
  getTaskList,
  loadTaskIndex,
  onTaskIndexChange,
  refreshTaskFile,
  removeNoteTaskRefs,
  replaceAllNoteTaskRefs,
  setNoteTaskRefs,
  startTaskIndex
} from '../taskIndex';
import { extractTaskRefs } from '../../shared/taskLinks';

describe('taskIndex', () => {
  let vault: string;
  const opts = (): { expectedGeneration: number; tool: string } => ({
    expectedGeneration: vaultState.getGeneration(),
    tool: 'test'
  });

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-taskindex-test-'));
    vaultState.setVaultPath(null);
    clearTaskIndex();
  });

  afterEach(() => {
    vaultState.setVaultPath(null);
    clearTaskIndex();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('loads tasks and problems, with summaries for the list', async () => {
    const a = await createTask(vault, { title: 'A', notes: 'Some notes' }, opts());
    fs.writeFileSync(path.join(vault, '_tasks', 'k3f9a2xq.md'), 'broken');
    expect(getTaskList().ready).toBe(false);
    await loadTaskIndex(vault);
    const list = getTaskList();
    expect(list.ready).toBe(true);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({
      id: a.id,
      title: 'A',
      hasNotes: true,
      commentCount: 0,
      linkCount: 0
    });
    expect(list.tasks[0]).not.toHaveProperty('notes');
    expect(list.problems.map((p) => p.path)).toEqual(['_tasks/k3f9a2xq.md']);
  });

  it('refreshes and forgets single files', async () => {
    await loadTaskIndex(vault);
    const t = await createTask(vault, { title: 'Later' }, opts());
    await refreshTaskFile(vault, `_tasks/${t.id}.md`);
    expect(getTaskDetail(t.id)?.task.title).toBe('Later');

    fs.writeFileSync(path.join(vault, '_tasks', `${t.id}.md`), '---\nstatus: nope\n---\n');
    await refreshTaskFile(vault, `_tasks/${t.id}.md`);
    expect(getTaskDetail(t.id)).toBeNull();
    expect(getTaskList().problems).toHaveLength(1);

    forgetTaskFile(`_tasks/${t.id}.md`);
    expect(getTaskList().problems).toHaveLength(0);
  });

  it('tracks which notes link to a task', async () => {
    const t = await createTask(vault, { title: 'Pay rent' }, opts());
    await loadTaskIndex(vault);
    replaceAllNoteTaskRefs({
      'Daily/2026-11-28.md': extractTaskRefs(`- [[_task:${t.id}|Pay rent]]\n- other`),
      'Empty.md': []
    });
    setNoteTaskRefs(
      'Home.md',
      extractTaskRefs(`Intro\n\n- [[_task:${t.id}|Pay rent]] and [[_task:${t.id}]]`)
    );
    expect(getTaskLinks(t.id)).toEqual([
      { note: 'Daily/2026-11-28.md', line: 1 },
      { note: 'Home.md', line: 3 },
      { note: 'Home.md', line: 3 }
    ]);
    expect(getTaskList().tasks[0].linkCount).toBe(3);
    expect(getTaskDetail(t.id)?.links).toHaveLength(3);

    removeNoteTaskRefs('Home.md');
    setNoteTaskRefs('Daily/2026-11-28.md', []);
    expect(getTaskLinks(t.id)).toEqual([]);
  });

  it('notifies listeners, coalescing bursts of changes', async () => {
    const cb = vi.fn();
    const off = onTaskIndexChange(cb);
    try {
      setNoteTaskRefs('A.md', extractTaskRefs('[[_task:k3f9a2xq|x]]'));
      setNoteTaskRefs('B.md', extractTaskRefs('[[_task:k3f9a2xq|x]]'));
      await new Promise((r) => setTimeout(r, 80));
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('follows the vault: loads on open, clears on close', async () => {
    await createTask(vault, { title: 'Follow' }, opts());
    const stop = startTaskIndex();
    try {
      vaultState.setVaultPath(vault);
      await vi.waitFor(() => expect(getTaskList().ready).toBe(true));
      expect(getTaskList().tasks.map((t) => t.title)).toEqual(['Follow']);
      vaultState.setVaultPath(null);
      expect(getTaskList()).toEqual({ ready: false, tasks: [], problems: [] });
    } finally {
      stop();
    }
  });

  it('discards a load overtaken by a vault change', async () => {
    await createTask(vault, { title: 'Stale' }, opts());
    const pending = loadTaskIndex(vault);
    vaultState.setVaultPath(vault); // generation moves on mid-load
    await pending;
    expect(getTaskList().ready).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import * as crypto from '../crypto';
import {
  createTask,
  deleteTask,
  loadAllTasks,
  readTask,
  updateTask,
  TaskNotFoundError
} from '../taskStore';
import { listVersions } from '../noteHistory';
import { applyTaskPatch, completeTask } from '../../shared/taskOps';
import { TaskFileError } from '../../shared/taskRecord';
import { VaultStateChangedError } from '../vaultWriter';

describe('taskStore', () => {
  let vault: string;
  const opts = (): { expectedGeneration: number; tool: string } => ({
    expectedGeneration: vaultState.getGeneration(),
    tool: 'test'
  });

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-taskstore-test-'));
    vaultState.setVaultPath(null);
  });

  afterEach(() => {
    vaultState.setVaultPath(null);
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('creates a task file in _tasks/ and reads it back', async () => {
    const task = await createTask(
      vault,
      { title: 'Pay rent', due: '2026-12-01', tags: ['bills'] },
      opts()
    );
    const file = path.join(vault, '_tasks', `${task.id}.md`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('title: Pay rent');
    const back = await readTask(vault, task.id);
    expect(back).toMatchObject({
      id: task.id,
      title: 'Pay rent',
      due: '2026-12-01',
      tags: ['bills']
    });
  });

  it('updates a task and keeps the replaced version in history', async () => {
    const task = await createTask(vault, { title: 'Pay rent' }, opts());
    const updated = await updateTask(
      vault,
      task.id,
      (t) => applyTaskPatch(t, { priority: 'high' }),
      {
        ...opts(),
        summary: 'Set priority'
      }
    );
    expect(updated.priority).toBe('high');
    expect((await readTask(vault, task.id)).priority).toBe('high');
    const versions = await listVersions(vault, { path: `_tasks/${task.id}.md` });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ tool: 'test', summary: 'Set priority' });
  });

  it('writes nothing when the change throws', async () => {
    const task = await createTask(vault, { title: 'Once' }, opts());
    const before = fs.readFileSync(path.join(vault, '_tasks', `${task.id}.md`), 'utf-8');
    await expect(
      updateTask(
        vault,
        task.id,
        () => {
          throw new TaskFileError('refused');
        },
        opts()
      )
    ).rejects.toThrow('refused');
    expect(fs.readFileSync(path.join(vault, '_tasks', `${task.id}.md`), 'utf-8')).toBe(before);
  });

  it('never rewrites a file it cannot parse', async () => {
    fs.mkdirSync(path.join(vault, '_tasks'), { recursive: true });
    const file = path.join(vault, '_tasks', 'k3f9a2xq.md');
    fs.writeFileSync(file, '---\nstatus: todo\n---\n'); // no title
    await expect(updateTask(vault, 'k3f9a2xq', (t) => completeTask(t), opts())).rejects.toThrow(
      'title is required'
    );
    expect(fs.readFileSync(file, 'utf-8')).toBe('---\nstatus: todo\n---\n');
  });

  it('reports missing tasks', async () => {
    await expect(readTask(vault, 'k3f9a2xq')).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(updateTask(vault, 'k3f9a2xq', (t) => t, opts())).rejects.toBeInstanceOf(
      TaskNotFoundError
    );
    await expect(readTask(vault, '../notes')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('deletes a task, keeping it in history', async () => {
    const task = await createTask(vault, { title: 'Temporary' }, opts());
    await deleteTask(vault, task.id, opts());
    expect(fs.existsSync(path.join(vault, '_tasks', `${task.id}.md`))).toBe(false);
    const versions = await listVersions(vault, { path: `_tasks/${task.id}.md` });
    expect(versions[0]).toMatchObject({ kind: 'delete' });
  });

  it('aborts a write if the vault changed since the caller looked', async () => {
    const gen = vaultState.getGeneration();
    vaultState.setVaultPath(vault); // bumps the generation
    await expect(
      createTask(vault, { title: 'x' }, { expectedGeneration: gen, tool: 't' })
    ).rejects.toBeInstanceOf(VaultStateChangedError);
  });

  it('loads every task and lists problem files separately', async () => {
    const a = await createTask(vault, { title: 'A' }, opts());
    const b = await createTask(vault, { title: 'B' }, opts());
    fs.writeFileSync(path.join(vault, '_tasks', 'k3f9a2xq.md'), 'no frontmatter');
    fs.writeFileSync(path.join(vault, '_tasks', 'README.md'), '# not a task');
    fs.writeFileSync(path.join(vault, '_tasks', 'notes.txt'), 'ignored');
    const { tasks, problems } = await loadAllTasks(vault);
    expect(tasks.map((t) => t.title).sort()).toEqual(['A', 'B']);
    expect(tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(problems.map((p) => p.path).sort()).toEqual(['_tasks/README.md', '_tasks/k3f9a2xq.md']);
    expect(problems.find((p) => p.path === '_tasks/README.md')?.error).toContain(
      'not a task file name'
    );
  });

  it('treats a vault without _tasks/ as having no tasks', async () => {
    expect(await loadAllTasks(vault)).toEqual({ tasks: [], problems: [] });
  });

  describe('encrypted vault', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(vault, '.phosphor'), { recursive: true });
      fs.writeFileSync(path.join(vault, '.phosphor', 'security.json'), '{}');
    });

    it('encrypts task files and reads them back', async () => {
      const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
      vaultState.setVaultPath(vault);
      vaultState.setMasterKey(key);
      const task = await createTask(vault, { title: 'Secret errand' }, opts());
      const raw = fs.readFileSync(path.join(vault, '_tasks', `${task.id}.md`));
      expect(crypto.isEncrypted(raw)).toBe(true);
      expect((await readTask(vault, task.id)).title).toBe('Secret errand');
      const updated = await updateTask(vault, task.id, (t) => completeTask(t), opts());
      expect(updated.status).toBe('done');
      expect(crypto.isEncrypted(fs.readFileSync(path.join(vault, '_tasks', `${task.id}.md`)))).toBe(
        true
      );
    });

    it('refuses to load while locked rather than reporting every file as a problem', async () => {
      const key = crypto.deriveMasterKey('hunter2', crypto.generateSalt());
      vaultState.setVaultPath(vault);
      vaultState.setMasterKey(key);
      await createTask(vault, { title: 'Secret' }, opts());
      vaultState.clearMasterKey();
      await expect(loadAllTasks(vault)).rejects.toThrow();
    });
  });
});

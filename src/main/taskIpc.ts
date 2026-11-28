/**
 * IPC for task files (`_tasks/`): queries against the task index and writes
 * through the task store. Channel names use `task-records:` to stay apart
 * from the older inline-checkbox task channels (`tasks:*`).
 *
 * Every write records the replaced version to note history, updates the index
 * straight away (rather than waiting for the file watcher), and the index's
 * change notification is forwarded to all windows as `task-records:changed`.
 */
import { ipcMain, BrowserWindow } from 'electron';
import * as vaultState from './vaultState';
import { VaultNotOpenError } from './vaultReader';
import { createTask, deleteTask, updateTask, type WriteOptions } from './taskStore';
import {
  getTaskDetail,
  getTaskList,
  onTaskIndexChange,
  removeTask,
  upsertTask,
  type TaskDetail,
  type TaskListSnapshot
} from './taskIndex';
import {
  addComment,
  applyTaskPatch,
  completeTask,
  deleteComment,
  editComment,
  skipOccurrence,
  type NewTaskInput,
  type TaskPatch
} from '../shared/taskOps';
import type { TaskRecord } from '../shared/taskRecord';

const TOOL = 'tasks-ui';

function openVault(): string {
  const vp = vaultState.getVaultPath();
  if (!vp) throw new VaultNotOpenError();
  return vp;
}

function writeOpts(summary: string): WriteOptions {
  return { expectedGeneration: vaultState.getGeneration(), tool: TOOL, summary };
}

async function change(
  id: string,
  summary: string,
  fn: (task: TaskRecord) => TaskRecord
): Promise<TaskRecord> {
  const task = await updateTask(openVault(), id, fn, writeOpts(summary));
  upsertTask(task);
  return task;
}

export function setupTaskIPC(): void {
  onTaskIndexChange(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('task-records:changed');
    }
  });

  ipcMain.handle('task-records:list', async (): Promise<TaskListSnapshot> => {
    if (!(await vaultState.isReadable())) return { ready: false, tasks: [], problems: [] };
    return getTaskList();
  });

  ipcMain.handle('task-records:get', async (_, id: string): Promise<TaskDetail | null> => {
    if (!(await vaultState.isReadable())) return null;
    return getTaskDetail(id);
  });

  ipcMain.handle('task-records:create', async (_, input: NewTaskInput): Promise<TaskRecord> => {
    const task = await createTask(openVault(), input, writeOpts('Created task'));
    upsertTask(task);
    return task;
  });

  ipcMain.handle('task-records:update', (_, id: string, patch: TaskPatch) =>
    change(id, 'Updated task', (t) => applyTaskPatch(t, patch))
  );

  ipcMain.handle('task-records:complete', (_, id: string) =>
    change(id, 'Completed task', (t) => completeTask(t))
  );

  ipcMain.handle('task-records:skip', (_, id: string) =>
    change(id, 'Skipped occurrence', (t) => skipOccurrence(t))
  );

  ipcMain.handle('task-records:add-comment', (_, id: string, text: string) =>
    change(id, 'Added comment', (t) => addComment(t, text))
  );

  ipcMain.handle('task-records:edit-comment', (_, id: string, at: string, text: string) =>
    change(id, 'Edited comment', (t) => editComment(t, at, text))
  );

  ipcMain.handle('task-records:delete-comment', (_, id: string, at: string) =>
    change(id, 'Deleted comment', (t) => deleteComment(t, at))
  );

  ipcMain.handle('task-records:delete', async (_, id: string): Promise<void> => {
    await deleteTask(openVault(), id, writeOpts('Deleted task'));
    removeTask(id);
  });
}

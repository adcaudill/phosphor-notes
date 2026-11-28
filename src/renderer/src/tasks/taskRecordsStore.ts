/**
 * The renderer's copy of the task index (task files in `_tasks/`): the list
 * of task summaries and problem files, refetched whenever the main process
 * says something changed. One shared store, so the editor's task-link
 * widgets and the React views always agree.
 *
 * Writes go straight to `window.phosphor.taskRecords`; the store catches up
 * through the change notification that every write triggers.
 */
import { useSyncExternalStore } from 'react';
import type { TaskListSnapshot, TaskSummary } from '../../../shared/taskViews';

const EMPTY: TaskListSnapshot = { ready: false, tasks: [], problems: [] };

let snapshot: TaskListSnapshot = EMPTY;
let byId = new Map<string, TaskSummary>();
const listeners = new Set<() => void>();
let fetching: Promise<void> | null = null;
let refetchQueued = false;

function setSnapshot(next: TaskListSnapshot): void {
  snapshot = next;
  byId = new Map(next.tasks.map((t) => [t.id, t]));
  for (const cb of listeners) cb();
}

/** Fetches the current list; coalesces calls that arrive while a fetch is running. */
export function refreshTaskRecords(): Promise<void> {
  if (fetching) {
    refetchQueued = true;
    return fetching;
  }
  fetching = (async () => {
    try {
      const api = window.phosphor?.taskRecords;
      if (api) setSnapshot(await api.list());
    } catch (err) {
      console.error('[Tasks] failed to load task list:', err);
    } finally {
      fetching = null;
      if (refetchQueued) {
        refetchQueued = false;
        void refreshTaskRecords();
      }
    }
  })();
  return fetching;
}

/** Starts following the main process's task index. Returns a stop function. */
export function startTaskRecordsSync(): () => void {
  void refreshTaskRecords();
  const off = window.phosphor?.taskRecords?.onChanged(() => void refreshTaskRecords());
  return () => off?.();
}

export function subscribeTaskRecords(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTaskRecordsSnapshot(): TaskListSnapshot {
  return snapshot;
}

/** One task's summary, or undefined if there's no such task (or the list hasn't loaded yet). */
export function getTaskSummary(id: string): TaskSummary | undefined {
  return byId.get(id);
}

export function isTaskRecordsReady(): boolean {
  return snapshot.ready;
}

/** React hook: the current task list snapshot. */
export function useTaskRecords(): TaskListSnapshot {
  return useSyncExternalStore(subscribeTaskRecords, getTaskRecordsSnapshot);
}

/** For tests: replace the snapshot directly. */
export function __setTaskRecordsSnapshotForTests(next: TaskListSnapshot): void {
  setSnapshot(next);
}

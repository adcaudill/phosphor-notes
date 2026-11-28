/**
 * The in-memory index of task files, plus which notes link to which tasks.
 *
 * - Tasks: every `_tasks/<id>.md`, loaded when a vault opens or unlocks,
 *   cleared when it closes or locks, and kept current from the app's own
 *   writes and the file watcher.
 * - Links: `[[_task:<id>|...]]` occurrences per note, from the indexer's
 *   full scan and its per-file updates.
 *
 * Runs in the main process (task files are parsed with the `yaml` library,
 * which the indexer worker's dev-mode fallback can't load). Listeners are
 * told when anything changes; the renderer and MCP query on demand.
 */
import { EventEmitter } from 'events';
import * as vaultState from './vaultState';
import { loadAllTasks, loadTaskFile } from './taskStore';
import type {
  TaskDetail,
  TaskFileProblem,
  TaskLinkLocation,
  TaskListSnapshot,
  TaskSummary
} from '../shared/taskViews';

export type { TaskDetail, TaskLinkLocation, TaskListSnapshot, TaskSummary };
import { taskIdFromPath, type TaskRecord } from '../shared/taskRecord';
import type { TaskRef } from '../shared/taskLinks';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let tasks = new Map<string, TaskRecord>();
let problems = new Map<string, TaskFileProblem>();
/** note path -> the task links in it (only notes with at least one). */
let refsByNote = new Map<string, TaskRef[]>();
let ready = false;
let loadToken = 0;
let notifyTimer: NodeJS.Timeout | null = null;

function notify(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    emitter.emit('changed');
  }, 30);
}

/** Called (debounced) whenever tasks, problems or links change. Returns an unsubscribe function. */
export function onTaskIndexChange(cb: () => void): () => void {
  emitter.on('changed', cb);
  return () => emitter.off('changed', cb);
}

/** Empties the index (vault closed, locked, or switching). */
export function clearTaskIndex(): void {
  loadToken += 1;
  tasks = new Map();
  problems = new Map();
  refsByNote = new Map();
  ready = false;
  notify();
}

/** (Re)loads every task file for `vaultPath`. A load overtaken by a newer one (or a vault change) is discarded. */
export async function loadTaskIndex(vaultPath: string): Promise<void> {
  const token = ++loadToken;
  const generation = vaultState.getGeneration();
  try {
    const result = await loadAllTasks(vaultPath);
    if (token !== loadToken || generation !== vaultState.getGeneration()) return;
    tasks = new Map(result.tasks.map((t) => [t.id, t]));
    problems = new Map(result.problems.map((p) => [p.path, p]));
    ready = true;
    notify();
  } catch (err) {
    if (token !== loadToken) return;
    console.error('[TaskIndex] failed to load tasks:', err);
  }
}

/**
 * Follows the vault: loads when a vault opens, switches or unlocks (and can
 * be read), clears when it closes or locks. Call once at startup.
 */
export function startTaskIndex(): () => void {
  return vaultState.onChange(({ reason }) => {
    if (reason === 'closed' || reason === 'locked') {
      clearTaskIndex();
      return;
    }
    clearTaskIndex();
    const vp = vaultState.getVaultPath();
    if (!vp) return;
    void vaultState.isReadable().then((readable) => {
      if (readable && vaultState.getVaultPath() === vp) void loadTaskIndex(vp);
    });
  });
}

/** Re-reads one file in `_tasks/` after it was added or changed (by the app or on disk). */
export async function refreshTaskFile(vaultPath: string, relPath: string): Promise<void> {
  const key = relPath.replace(/\\/g, '/');
  try {
    const result = await loadTaskFile(vaultPath, key);
    const id = taskIdFromPath(key);
    if (!result) {
      if (id) tasks.delete(id);
      problems.delete(key);
    } else if ('task' in result) {
      tasks.set(result.task.id, result.task);
      problems.delete(key);
    } else {
      if (id) tasks.delete(id);
      problems.set(key, result.problem);
    }
    notify();
  } catch (err) {
    console.error('[TaskIndex] failed to refresh', key, err);
  }
}

/** Drops a file in `_tasks/` that was deleted. */
export function forgetTaskFile(relPath: string): void {
  const key = relPath.replace(/\\/g, '/');
  const id = taskIdFromPath(key);
  const had = (id !== null && tasks.delete(id)) || problems.delete(key);
  if (had) notify();
}

/** Records a task the app just wrote, without waiting for the file watcher. */
export function upsertTask(task: TaskRecord): void {
  tasks.set(task.id, task);
  problems.delete(`_tasks/${task.id}.md`);
  notify();
}

/** Forgets a task the app just deleted. */
export function removeTask(id: string): void {
  if (tasks.delete(id)) notify();
}

/** Replaces the task links found in one note (an empty list removes the note). */
export function setNoteTaskRefs(note: string, refs: TaskRef[]): void {
  const key = note.replace(/\\/g, '/');
  const before = refsByNote.get(key);
  if (refs.length === 0) {
    if (refsByNote.delete(key)) notify();
    return;
  }
  if (before && JSON.stringify(before) === JSON.stringify(refs)) return;
  refsByNote.set(key, refs);
  notify();
}

/** Forgets a note's task links (the note was deleted or renamed away). */
export function removeNoteTaskRefs(note: string): void {
  if (refsByNote.delete(note.replace(/\\/g, '/'))) notify();
}

/** Replaces all note links at once (after the indexer's full scan). */
export function replaceAllNoteTaskRefs(byNote: Record<string, TaskRef[]>): void {
  refsByNote = new Map(Object.entries(byNote).filter(([, refs]) => refs.length > 0));
  notify();
}

/** Every place a task is linked from, in note order. */
export function getTaskLinks(id: string): TaskLinkLocation[] {
  const out: TaskLinkLocation[] = [];
  for (const [note, refs] of refsByNote) {
    for (const r of refs) if (r.id === id) out.push({ note, line: r.line });
  }
  return out.sort((a, b) => a.note.localeCompare(b.note) || a.line - b.line);
}

function linkCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const refs of refsByNote.values()) {
    for (const r of refs) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  }
  return counts;
}

export function summarizeTask(task: TaskRecord, linkCount: number): TaskSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { notes, log, extra, ...fields } = task;
  return {
    ...fields,
    hasNotes: notes.trim().length > 0,
    commentCount: log.filter((e) => e.type === 'comment').length,
    linkCount
  };
}

/** All tasks (summaries) and problem files. */
export function getTaskList(): TaskListSnapshot {
  const counts = linkCounts();
  return {
    ready,
    tasks: [...tasks.values()].map((t) => summarizeTask(t, counts.get(t.id) ?? 0)),
    problems: [...problems.values()].sort((a, b) => a.path.localeCompare(b.path))
  };
}

/** One task with its notes, log and links; null if there's no such task. */
export function getTaskDetail(id: string): TaskDetail | null {
  const task = tasks.get(id);
  return task ? { task, links: getTaskLinks(id) } : null;
}

/** The task record itself (null if unknown) - for callers that need the full object. */
export function getTaskRecord(id: string): TaskRecord | null {
  return tasks.get(id) ?? null;
}

export function isTaskIndexReady(): boolean {
  return ready;
}

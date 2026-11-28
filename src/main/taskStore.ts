/**
 * Reading and writing task files (`_tasks/<id>.md`). Every write goes through
 * the vault writer's machinery: atomic temp-file-and-rename, encryption when
 * the vault is encrypted, the per-file write lock, and a note-history entry
 * for the version being replaced (so the history view can restore a task).
 *
 * What an operation does to a task's fields lives in src/shared/taskOps.ts;
 * this module only loads, saves and deletes.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';
import { readDecrypted, VaultLockedError } from './vaultReader';
import { resolveWritableNotePath } from './vaultPaths';
import {
  deleteNote,
  encodeForVault,
  modifyNote,
  NoteNotFoundError,
  type HistoryOption
} from './vaultWriter';
import {
  TASKS_DIR,
  TaskFileError,
  generateTaskId,
  isValidTaskId,
  parseTaskFile,
  serializeTaskFile,
  taskFilePath,
  taskIdFromPath,
  type TaskRecord
} from '../shared/taskRecord';
import { createTaskRecord, type NewTaskInput } from '../shared/taskOps';
import type { TaskFileProblem } from '../shared/taskViews';

export type { TaskFileProblem };

export class TaskNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export interface WriteOptions {
  /** The vault generation the caller captured; the write aborts if the vault was locked/switched since. */
  expectedGeneration: number;
  /** For the history entry, e.g. "tasks-ui" or an MCP tool name. */
  tool: string;
  summary?: string;
  now?: Date;
}

function assertId(id: string): void {
  if (!isValidTaskId(id)) throw new TaskNotFoundError(id);
}

/** Reads and parses one task file. Throws TaskNotFoundError, or TaskFileError if it isn't a valid task. */
export async function readTask(vaultPath: string, id: string): Promise<TaskRecord> {
  assertId(id);
  const abs = path.join(vaultPath, taskFilePath(id));
  let text: string;
  try {
    text = (await readDecrypted(abs)).toString('utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof NoteNotFoundError) {
      throw new TaskNotFoundError(id);
    }
    throw err;
  }
  const parsed = parseTaskFile(text, id);
  if (!parsed.ok) throw new TaskFileError(parsed.error);
  return parsed.task;
}

/** Parses one file in `_tasks/` (any name): a task, a problem, or null for files that aren't Markdown. */
export async function loadTaskFile(
  vaultPath: string,
  relPath: string
): Promise<{ task: TaskRecord } | { problem: TaskFileProblem } | null> {
  const normalized = relPath.replace(/\\/g, '/');
  if (!normalized.toLowerCase().endsWith('.md')) return null;
  const id = taskIdFromPath(normalized);
  if (!id) {
    return {
      problem: {
        path: normalized,
        error: 'not a task file name (expected _tasks/<8-character id>.md)'
      }
    };
  }
  try {
    const text = (await readDecrypted(path.join(vaultPath, normalized))).toString('utf-8');
    const parsed = parseTaskFile(text, id);
    return parsed.ok
      ? { task: parsed.task }
      : { problem: { path: normalized, error: parsed.error } };
  } catch (err) {
    // A locked vault isn't a problem with the file: stop, and load again once unlocked.
    if (err instanceof VaultLockedError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // deleted meanwhile
    return { problem: { path: normalized, error: (err as Error).message } };
  }
}

/** Loads every task file in the vault. Missing `_tasks/` just means no tasks yet. */
export async function loadAllTasks(
  vaultPath: string
): Promise<{ tasks: TaskRecord[]; problems: TaskFileProblem[] }> {
  const dir = path.join(vaultPath, TASKS_DIR);
  let names: string[];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], problems: [] };
    throw err;
  }

  const tasks: TaskRecord[] = [];
  const problems: TaskFileProblem[] = [];
  const BATCH = 64;
  for (let i = 0; i < names.length; i += BATCH) {
    const results = await Promise.all(
      names.slice(i, i + BATCH).map((name) => loadTaskFile(vaultPath, `${TASKS_DIR}/${name}`))
    );
    for (const r of results) {
      if (!r) continue;
      if ('task' in r) tasks.push(r.task);
      else problems.push(r.problem);
    }
  }
  return { tasks, problems };
}

/** Creates a new task file with a fresh id. */
export async function createTask(
  vaultPath: string,
  input: NewTaskInput,
  opts: WriteOptions
): Promise<TaskRecord> {
  await fsp.mkdir(path.join(vaultPath, TASKS_DIR), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = generateTaskId();
    const record = createTaskRecord(input, id, opts.now);
    const rel = taskFilePath(id);
    const abs = await resolveWritableNotePath(vaultPath, rel);
    const buf = await encodeForVault(vaultPath, Buffer.from(serializeTaskFile(record), 'utf-8'), {
      expectedGeneration: opts.expectedGeneration
    });
    try {
      await writeFileAtomic(abs, buf, { exclusive: true });
      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; // id collision: pick another
      throw err;
    }
  }
  throw new Error('could not find a free task id');
}

/**
 * Reads a task, applies `change` to it, and writes the result - under the
 * file's write lock, with the replaced version saved to history. `change`
 * should throw to refuse; nothing is written then. A file that doesn't parse
 * is never rewritten (TaskFileError).
 */
export async function updateTask(
  vaultPath: string,
  id: string,
  change: (task: TaskRecord) => TaskRecord,
  opts: WriteOptions
): Promise<TaskRecord> {
  assertId(id);
  const history: HistoryOption = { tool: opts.tool, summary: opts.summary ?? 'Updated task' };
  try {
    const result = await modifyNote<TaskRecord>(
      vaultPath,
      taskFilePath(id),
      (doc) => {
        const parsed = parseTaskFile(doc, id);
        if (!parsed.ok) throw new TaskFileError(parsed.error);
        const next = change(parsed.task);
        return { doc: serializeTaskFile(next), meta: next };
      },
      { expectedGeneration: opts.expectedGeneration, history }
    );
    return result.meta;
  } catch (err) {
    if (err instanceof NoteNotFoundError) throw new TaskNotFoundError(id);
    throw err;
  }
}

/** Deletes a task file, saving it to history first so it can be restored. */
export async function deleteTask(vaultPath: string, id: string, opts: WriteOptions): Promise<void> {
  assertId(id);
  try {
    await deleteNote(vaultPath, taskFilePath(id), {
      expectedGeneration: opts.expectedGeneration,
      history: { tool: opts.tool, summary: opts.summary ?? 'Deleted task' }
    });
  } catch (err) {
    if (err instanceof NoteNotFoundError) throw new TaskNotFoundError(id);
    throw err;
  }
}

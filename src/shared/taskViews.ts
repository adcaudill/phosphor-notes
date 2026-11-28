/**
 * Shapes the task index hands out (to the renderer over IPC, and to MCP).
 * Types only.
 */
import type { TaskRecord } from './taskRecord';

/** A task file that couldn't be read as a task (shown in the Tasks tab's problems list, never overwritten). */
export interface TaskFileProblem {
  path: string;
  error: string;
}

/** Where a task is linked from. */
export interface TaskLinkLocation {
  note: string;
  line: number;
}

/** A task as the list views need it: everything but the notes body and log, plus a few counts. */
export interface TaskSummary extends Omit<TaskRecord, 'notes' | 'log' | 'extra'> {
  hasNotes: boolean;
  commentCount: number;
  linkCount: number;
  /** The notes that link to it (each once). */
  linkedNotes: string[];
}

export interface TaskListSnapshot {
  /** False until the first load for the open vault has finished. */
  ready: boolean;
  tasks: TaskSummary[];
  problems: TaskFileProblem[];
}

export interface TaskDetail {
  task: TaskRecord;
  links: TaskLinkLocation[];
}

/** One note in a conversion preview (inline checkbox tasks -> task files). */
export interface ConversionPreviewNote {
  note: string;
  /** Tasks that would be created. */
  tasks: number;
  /** Completed history lines that would be folded into a repeating task. */
  folded: number;
  /** A few of the titles. */
  samples: string[];
}

export interface ConversionPreview {
  notes: ConversionPreviewNote[];
  tasks: number;
}

export interface ConversionResult {
  tasksCreated: number;
  notesChanged: string[];
  skipped: Array<{ note: string; error: string }>;
  /** Groups the note history entries this run made. */
  opId: string;
}

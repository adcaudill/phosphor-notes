/**
 * Converting inline checkbox tasks with metadata into task files, across the
 * vault or in given notes. What each line becomes is decided in
 * src/shared/taskMigrate.ts; this module reads and writes.
 *
 * Per note: read it, plan, create the task files, then rewrite the note -
 * only if it's unchanged since it was read (content hash). If the note
 * changed meanwhile, the tasks just created for it are deleted again and the
 * note is reported as skipped. Every note rewrite is a history entry, and all
 * entries of one run share an operation id.
 */
import { listNotes, readNoteText } from './vaultReader';
import { modifyNote } from './vaultWriter';
import { contentHash } from './contentHash';
import { newOperationId } from './noteHistory';
import { deleteTask, writeNewTask } from './taskStore';
import { upsertTask, removeTask } from './taskIndex';
import { createTaskRecord } from '../shared/taskOps';
import { localDate, localDateTime } from '../shared/taskRecord';
import {
  applyNoteMigration,
  isConvertibleTaskLine,
  planNoteMigration,
  withMigratedHistory
} from '../shared/taskMigrate';
import type {
  ConversionPreview,
  ConversionPreviewNote,
  ConversionResult
} from '../shared/taskViews';

const TOOL = 'task-conversion';

type MigrationPreviewNote = ConversionPreviewNote;
type MigrationPreview = ConversionPreview;
type MigrationResult = ConversionResult;

async function candidateNotes(vaultPath: string, notes?: string[]): Promise<string[]> {
  if (notes && notes.length) return notes;
  return (await listNotes(vaultPath)).map((n) => n.path);
}

/** What converting would do, without writing anything. */
export async function previewMigration(
  vaultPath: string,
  opts: { notes?: string[]; now?: Date } = {}
): Promise<MigrationPreview> {
  const now = opts.now ?? new Date();
  const out: MigrationPreviewNote[] = [];
  for (const note of await candidateNotes(vaultPath, opts.notes)) {
    let doc: string;
    try {
      doc = await readNoteText(vaultPath, note);
    } catch {
      continue;
    }
    if (!doc.split('\n').some(isConvertibleTaskLine)) continue;
    const plan = planNoteMigration(doc, localDate(now), localDateTime(now));
    if (plan.tasks.length === 0) continue;
    out.push({
      note,
      tasks: plan.tasks.length,
      folded: plan.removed.length,
      samples: plan.tasks.slice(0, 3).map((t) => t.input.title)
    });
  }
  return { notes: out, tasks: out.reduce((n, p) => n + p.tasks, 0) };
}

/** Converts the inline tasks with metadata in the given notes (or the whole vault). */
export async function runMigration(
  vaultPath: string,
  opts: { notes?: string[]; expectedGeneration: number; now?: Date }
): Promise<MigrationResult> {
  const opId = newOperationId();
  const result: MigrationResult = { tasksCreated: 0, notesChanged: [], skipped: [], opId };

  for (const note of await candidateNotes(vaultPath, opts.notes)) {
    const now = opts.now ?? new Date();
    let doc: string;
    try {
      doc = await readNoteText(vaultPath, note);
    } catch (err) {
      result.skipped.push({ note, error: (err as Error).message });
      continue;
    }
    if (!doc.split('\n').some(isConvertibleTaskLine)) continue;
    const plan = planNoteMigration(doc, localDate(now), localDateTime(now));
    if (plan.tasks.length === 0) continue;

    const hash = contentHash(doc);
    const created: Array<{ id: string; title: string }> = [];
    try {
      for (const planned of plan.tasks) {
        const record = await writeNewTask(
          vaultPath,
          (id) => withMigratedHistory(createTaskRecord(planned.input, id, now), planned, note),
          { expectedGeneration: opts.expectedGeneration, tool: TOOL, now }
        );
        created.push({ id: record.id, title: record.title });
        upsertTask(record);
      }
      await modifyNote(
        vaultPath,
        note,
        (current) => ({ doc: applyNoteMigration(current, plan, created), meta: null }),
        {
          expectedGeneration: opts.expectedGeneration,
          expectedHash: hash,
          history: {
            tool: TOOL,
            summary: `Converted ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'} to task files`,
            opId
          }
        }
      );
      result.tasksCreated += created.length;
      result.notesChanged.push(note);
    } catch (err) {
      // Undo this note's half-finished conversion: its tasks go, the note stays as it was.
      for (const c of created) {
        try {
          await deleteTask(vaultPath, c.id, {
            expectedGeneration: opts.expectedGeneration,
            tool: TOOL,
            summary: 'Conversion rolled back'
          });
        } catch {
          // best effort
        }
        removeTask(c.id);
      }
      result.skipped.push({ note, error: (err as Error).message });
    }
  }
  return result;
}

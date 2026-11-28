/**
 * Keeps the title text in task links (`[[_task:<id>|<title>]]`) in step with
 * the task's title after a rename. The widget always shows the live title, so
 * this is about the note text itself reading right.
 *
 * Notes are rewritten through the vault writer (history entry per note). The
 * file watcher then picks each write up as an external change, which
 * refreshes the indexes and reloads the note if it's open in the editor.
 * Callers pass the note open in the editor as `exclude`: the editor updates
 * its own buffer instead, so an open note never gets a conflicting write.
 */
import { modifyNote, NoteNotFoundError } from './vaultWriter';
import { getTaskLinks } from './taskIndex';
import { replaceTaskLinkTitles } from '../shared/taskLinks';

export interface SyncLinkTitlesOptions {
  expectedGeneration: number;
  tool: string;
  /** Notes not to touch (e.g. the one open in the editor). */
  exclude?: string[];
}

/** Rewrites link titles for task `id` in every linking note. Returns the notes that changed. */
export async function syncTaskLinkTitles(
  vaultPath: string,
  id: string,
  title: string,
  opts: SyncLinkTitlesOptions
): Promise<string[]> {
  const skip = new Set(opts.exclude ?? []);
  const notes = [...new Set(getTaskLinks(id).map((l) => l.note))].filter((n) => !skip.has(n));
  const changed: string[] = [];
  for (const note of notes) {
    try {
      const result = await modifyNote(
        vaultPath,
        note,
        (doc) => {
          const r = replaceTaskLinkTitles(doc, id, title);
          return { doc: r.doc, meta: r.changed };
        },
        {
          expectedGeneration: opts.expectedGeneration,
          history: { tool: opts.tool, summary: 'Updated a task title in a link' }
        }
      );
      if (result.changed) changed.push(note);
    } catch (err) {
      // A note that vanished since it was indexed has nothing to update.
      if (!(err instanceof NoteNotFoundError)) throw err;
    }
  }
  return changed;
}

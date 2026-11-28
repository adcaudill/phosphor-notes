/**
 * Task links in notes: `[[_task:<id>|<title>]]`.
 *
 * Deliberately dependency-free (no imports): the indexer worker uses this,
 * and its dev-mode fallback inlines shared modules as plain source.
 */

/** Matches a task link. Group 1: id. Group 2: the title text after `|` (may be absent). */
export const TASK_LINK_RE = /\[\[_task:([a-z2-9]{8})(?:\|([^\]\n]*))?\]\]/g;

export interface TaskRef {
  id: string;
  /** 1-based line number in the note. */
  line: number;
  /** The title text written in the link (may be stale or empty). */
  title: string;
}

/** Every task link in a note, in order. */
export function extractTaskRefs(content: string): TaskRef[] {
  const refs: TaskRef[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(TASK_LINK_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      refs.push({ id: m[1], line: i + 1, title: (m[2] ?? '').trim() });
    }
  }
  return refs;
}

/** The text of a link to a task. Characters that would end the link are dropped from the title. */
export function formatTaskLink(id: string, title: string): string {
  const safe = title
    .replace(/[\]\n|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return safe ? `[[_task:${id}|${safe}]]` : `[[_task:${id}]]`;
}

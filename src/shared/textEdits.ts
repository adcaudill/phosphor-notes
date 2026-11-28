import { findOccurrences, wikilinkSpans, overlapsAny } from './textMatch';

/**
 * Exact-text find/replace edits for MCP's edit_note: pure logic, no
 * filesystem dependency. Each edit's `oldText` must match the current
 * document exactly once (unless `replaceAll`), which is what makes a
 * replace safe without line numbers: an ambiguous or stale target is
 * refused rather than guessed at.
 */

export interface TextEdit {
  oldText: string;
  /** Replacement text; empty deletes `oldText`. */
  newText: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replaceAll?: boolean;
  /** Only match oldText where it is not part of a longer word ("Melanie" but not "Melanies"). */
  wholeWord?: boolean;
  /** Ignore occurrences inside [[wikilinks]], so replacing a name never rewrites a link to its page. */
  skipLinks?: boolean;
}

/** One applied replacement, as whole lines before/after (for showing the user what changed). */
export interface TextChange {
  /** 1-based line where the replaced text started, in the document as it was when this edit applied. */
  line: number;
  removed: string[];
  added: string[];
}

export class TextNotFoundError extends Error {
  constructor(public readonly editIndex: number) {
    super(
      `Edit ${editIndex + 1}: oldText was not found in the note (after any earlier edits in this ` +
        'call). It must match the current text exactly, including whitespace and line breaks - ' +
        're-read the note and copy the passage as it is now.'
    );
    this.name = 'TextNotFoundError';
  }
}

export class AmbiguousTextError extends Error {
  constructor(
    public readonly editIndex: number,
    public readonly lines: number[]
  ) {
    super(
      `Edit ${editIndex + 1}: oldText matches ${lines.length} places (lines ${lines.join(', ')}). ` +
        'Include more surrounding text so it matches exactly one place, or set replaceAll to ' +
        'change every occurrence.'
    );
    this.name = 'AmbiguousTextError';
  }
}

export class EmptyOldTextError extends Error {
  constructor(public readonly editIndex: number) {
    super(`Edit ${editIndex + 1}: oldText must not be empty.`);
    this.name = 'InvalidArgumentError';
  }
}

const MAX_CHANGE_LINES = 40;

function lineNumberAt(doc: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (doc.charCodeAt(i) === 10) line++;
  return line;
}

function occurrences(doc: string, needle: string, edit: TextEdit): number[] {
  const found = findOccurrences(doc, needle, { wholeWord: edit.wholeWord });
  if (!edit.skipLinks) return found;
  const links = wikilinkSpans(doc);
  return found.filter((i) => !overlapsAny(i, needle.length, links));
}

function clip(lines: string[]): string[] {
  return lines.length <= MAX_CHANGE_LINES
    ? lines
    : [...lines.slice(0, MAX_CHANGE_LINES), `... (${lines.length - MAX_CHANGE_LINES} more lines)`];
}

/** Applies `edits` in order (each against the result of the previous ones); all succeed or this throws. */
export function applyTextEdits(
  doc: string,
  edits: TextEdit[]
): { doc: string; changes: TextChange[]; replacements: number } {
  let current = doc;
  const changes: TextChange[] = [];
  let replacements = 0;

  edits.forEach((edit, editIndex) => {
    const oldText = edit.oldText.replace(/\r\n?/g, '\n');
    const newText = edit.newText.replace(/\r\n?/g, '\n');
    if (oldText === '') throw new EmptyOldTextError(editIndex);

    const found = occurrences(current, oldText, edit);
    if (found.length === 0) throw new TextNotFoundError(editIndex);
    if (found.length > 1 && !edit.replaceAll) {
      throw new AmbiguousTextError(
        editIndex,
        found.map((i) => lineNumberAt(current, i))
      );
    }

    // Group occurrences whose lines touch, so a line changed by several
    // replacements is reported once, as it was before and after them all.
    const groups: Array<{ start: number; end: number; first: number; count: number }> = [];
    found.forEach((index, n) => {
      const lineStart = current.lastIndexOf('\n', index - 1) + 1;
      const nl = current.indexOf('\n', index + oldText.length);
      const lineEnd = nl === -1 ? current.length : nl;
      const last = groups[groups.length - 1];
      if (last && lineStart <= last.end) {
        last.end = Math.max(last.end, lineEnd);
        last.count++;
      } else {
        groups.push({ start: lineStart, end: lineEnd, first: n, count: 1 });
      }
    });

    let next = '';
    let cursor = 0;
    for (const index of found) {
      next += current.slice(cursor, index) + newText;
      cursor = index + oldText.length;
    }
    next += current.slice(cursor);

    const delta = newText.length - oldText.length;
    const editChanges: TextChange[] = groups.map((g) => {
      const newStart = g.start + g.first * delta;
      const newEnd = g.end + (g.first + g.count) * delta;
      return {
        line: lineNumberAt(current, g.start),
        removed: clip(current.slice(g.start, g.end).split('\n')),
        added: clip(next.slice(newStart, newEnd).split('\n'))
      };
    });
    current = next;
    replacements += found.length;
    changes.push(...editChanges);
  });

  return { doc: current, changes, replacements };
}

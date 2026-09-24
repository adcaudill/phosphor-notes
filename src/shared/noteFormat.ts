/**
 * Pure text-formatting logic for the MCP write tools: no filesystem or
 * Electron dependency, so it's usable and testable in complete isolation.
 * Reuses the renderer's own frontmatter helpers so notes created/appended to
 * via MCP look exactly like ones the app itself would produce.
 */
import {
  extractFrontmatter,
  generateDefaultFrontmatter,
  isDailyNote
} from '../renderer/src/utils/frontmatterUtils';

export type NoteMode = 'freeform' | 'outliner';

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/** A note's mode is purely its own frontmatter `mode: outliner` field - no other source of truth. */
export function detectNoteMode(doc: string): NoteMode {
  const { frontmatter } = extractFrontmatter(doc);
  return frontmatter?.content.mode === 'outliner' ? 'outliner' : 'freeform';
}

/** Whether `doc` already carries its own `---`-delimited frontmatter block. */
export function hasOwnFrontmatter(doc: string): boolean {
  return extractFrontmatter(doc).frontmatter !== null;
}

function leadingWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

function isFenceMarker(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

const BULLET_MARKER_RE = /^[-*+](\s+|$)/;

/**
 * Converts arbitrary caller-supplied lines into properly nested outliner
 * bullets: `- ` markers, 4 spaces per indent level. Infers the caller's own
 * indent unit (2 spaces, 4 spaces, a tab, ...) from the smallest positive
 * leading width it finds, re-emits at the app's 4-space convention, and
 * clamps so a level can never jump more than one deeper than the line
 * before it. Blank lines are dropped; fenced code blocks are passed through
 * as children of the previous bullet rather than turned into bullets.
 */
export function normalizeOutlinerLines(text: string): string[] {
  const lines = text.split('\n');

  let unit = 4;
  {
    let inFence = false;
    let smallestPositive = Infinity;
    for (const line of lines) {
      if (isFenceMarker(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || line.trim() === '') continue;
      const w = leadingWidth(line);
      if (w > 0 && w < smallestPositive) smallestPositive = w;
    }
    if (Number.isFinite(smallestPositive)) unit = smallestPositive;
  }

  const out: string[] = [];
  let lastLevel = -1;
  let inFence = false;

  for (const rawLine of lines) {
    if (isFenceMarker(rawLine)) {
      const level = Math.max(lastLevel, 0);
      out.push('    '.repeat(level + 1) + rawLine.trimStart());
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const level = Math.max(lastLevel, 0);
      out.push('    '.repeat(level + 1) + rawLine.trimStart());
      continue;
    }
    if (rawLine.trim() === '') continue;

    const width = leadingWidth(rawLine);
    const level = Math.min(Math.round(width / unit), lastLevel + 1);
    const stripped = rawLine.trimStart().replace(BULLET_MARKER_RE, '');
    if (stripped.trim() === '') continue; // a lone "-"/"* " etc. - nothing to bullet

    out.push('    '.repeat(level) + '- ' + stripped);
    lastLevel = level;
  }

  return out;
}

function isListLine(line: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s/.test(line);
}

function formatFreeformAppend(
  frontmatterRaw: string | null,
  body: string,
  addition: string
): { doc: string; appended: string } {
  const add = addition.replace(/^\n+/, '').replace(/\s+$/, '');
  if (add === '') {
    throw new InvalidArgumentError('content is empty after normalization');
  }

  const b = body.replace(/\s+$/, '');
  let newBody: string;
  if (b === '') {
    newBody = add + '\n';
  } else {
    const lastLine = b.split('\n').pop() ?? '';
    const firstLine = add.split('\n')[0] ?? '';
    const sep = isListLine(lastLine) && isListLine(firstLine) ? '\n' : '\n\n';
    newBody = b + sep + add + '\n';
  }

  const doc = frontmatterRaw ? frontmatterRaw + '\n' + newBody : newBody;
  return { doc, appended: add };
}

function formatOutlinerAppend(
  frontmatterRaw: string | null,
  body: string,
  addition: string
): { doc: string; appended: string } {
  // Strip the GUI's seeded trailing empty bullet(s) ("- ") from the
  // existing body before appending real content after them.
  let b = body.replace(/\s+$/, '');
  while (/^\s*-\s*$/.test(b.split('\n').pop() ?? '')) {
    const lines = b.split('\n');
    lines.pop();
    b = lines.join('\n');
  }

  const addLines = normalizeOutlinerLines(addition);
  if (addLines.length === 0) {
    throw new InvalidArgumentError('content produced no bullets after normalization');
  }

  const appended = addLines.join('\n');
  const newBody = (b ? b + '\n' : '') + appended + '\n';
  const doc = frontmatterRaw ? frontmatterRaw + '\n' + newBody : newBody;
  return { doc, appended };
}

/**
 * Appends `addition` to the end of `existingDoc`, formatted according to
 * `mode` (always detected by the caller from the note's own frontmatter via
 * `detectNoteMode` - never a user-supplied parameter for append_to_note).
 * Returns the full new document plus the exact text that was appended.
 */
export function formatAppend(
  existingDoc: string,
  addition: string,
  mode: NoteMode
): { doc: string; appended: string } {
  const normalizedAddition = addition.replace(/\r\n?/g, '\n');
  const { frontmatter, content: body } = extractFrontmatter(existingDoc);
  const frontmatterRaw = frontmatter ? frontmatter.raw : null;

  return mode === 'outliner'
    ? formatOutlinerAppend(frontmatterRaw, body, normalizedAddition)
    : formatFreeformAppend(frontmatterRaw, body, normalizedAddition);
}

/** Builds frontmatter for a brand-new note, fixing generateDefaultFrontmatter's gap of only emitting `mode:` for daily-note filenames. */
export function buildNewNoteFrontmatter(relPath: string, mode?: NoteMode): string {
  if (isDailyNote(relPath)) {
    return generateDefaultFrontmatter(relPath, mode);
  }
  const title = relPath.replace(/\.md$/i, '');
  const modeLine = mode === 'outliner' ? '\nmode: outliner' : '';
  return `---\ntitle: ${title}${modeLine}\n---`;
}

/** Builds a full new-note document (frontmatter + body) from plain body text and an optional mode. */
export function buildNewNoteDoc(relPath: string, body: string, mode?: NoteMode): string {
  const frontmatter = buildNewNoteFrontmatter(relPath, mode);

  let normalizedBody: string;
  if (mode === 'outliner') {
    normalizedBody = body.trim() === '' ? '- ' : normalizeOutlinerLines(body).join('\n');
  } else {
    normalizedBody = body.replace(/\s+$/, '');
  }

  return normalizedBody === '' ? frontmatter + '\n' : frontmatter + '\n' + normalizedBody + '\n';
}

export interface FormatTaskLineOptions {
  text: string;
  due?: string;
  recurrence?: string;
  status?: 'todo' | 'doing';
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECURRENCE_RE = /^\+\d+[dwmy]$/i;

function isValidCalendarDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Builds one `- [ ] text 📅 due 🔁 recurrence` task line, validating date/recurrence syntax up front. */
export function formatTaskLine(opts: FormatTaskLineOptions): string {
  const { due, recurrence, status } = opts;

  if (typeof opts.text !== 'string' || opts.text.trim() === '') {
    throw new InvalidArgumentError('text must be a non-empty string');
  }
  if (opts.text.includes('\n')) {
    throw new InvalidArgumentError('text must be a single line');
  }

  // Tolerate a caller that already included a checkbox marker.
  let text = opts.text.trim().replace(/^-?\s*\[[ x/]\]\s*/i, '');
  if (text === '') {
    throw new InvalidArgumentError('text must be a non-empty string');
  }
  if (/📅|🔁/.test(text)) {
    throw new InvalidArgumentError('pass due/recurrence as separate options, not embedded in text');
  }

  if (due !== undefined && (!DUE_DATE_RE.test(due) || !isValidCalendarDate(due))) {
    throw new InvalidArgumentError(`invalid due date: ${due} (expected YYYY-MM-DD)`);
  }
  if (recurrence !== undefined && !RECURRENCE_RE.test(recurrence)) {
    throw new InvalidArgumentError(`invalid recurrence: ${recurrence} (expected e.g. +1d, +2w, +1m, +1y)`);
  }

  const marker = status === 'doing' ? '/' : ' ';
  let line = `- [${marker}] ${text}`;
  if (due) line += ` 📅 ${due}`;
  if (recurrence) line += ` 🔁 ${recurrence.toLowerCase()}`;
  return line;
}

/** `YYYY-MM-DD.md` from local date parts - matches the app's own daily-note convention (not UTC). */
export function localDailyNoteFilename(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}.md`;
}

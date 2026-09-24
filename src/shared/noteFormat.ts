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
 *
 * `baseLevel` shifts every emitted line that many levels deeper - used by
 * `insertUnderBullet` to re-base freshly-normalized content so it lands as
 * a child of a specific existing bullet rather than always starting at the
 * top level.
 */
export function normalizeOutlinerLines(text: string, baseLevel = 0): string[] {
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
      out.push('    '.repeat(level + 1 + baseLevel) + rawLine.trimStart());
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const level = Math.max(lastLevel, 0);
      out.push('    '.repeat(level + 1 + baseLevel) + rawLine.trimStart());
      continue;
    }
    if (rawLine.trim() === '') continue;

    const width = leadingWidth(rawLine);
    const level = Math.min(Math.round(width / unit), lastLevel + 1);
    const stripped = rawLine.trimStart().replace(BULLET_MARKER_RE, '');
    if (stripped.trim() === '') continue; // a lone "-"/"* " etc. - nothing to bullet

    out.push('    '.repeat(level + baseLevel) + '- ' + stripped);
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

export class NotOutlinerModeError extends Error {
  constructor() {
    super(
      'This note is not in outliner mode - insert_under_bullet only applies to outliner notes; use append_to_note for a freeform note.'
    );
    this.name = 'NotOutlinerModeError';
  }
}

export class BulletNotFoundError extends Error {
  constructor(public readonly matchText: string) {
    super(`No bullet matching "${matchText}" was found in this note.`);
    this.name = 'BulletNotFoundError';
  }
}

export interface BulletMatch {
  /** 1-based line number within the note's body (frontmatter not counted). */
  line: number;
  /** The bullet's own text, with its marker and any checkbox stripped. */
  text: string;
}

export class AmbiguousMatchError extends Error {
  constructor(
    public readonly matchText: string,
    public readonly matches: BulletMatch[]
  ) {
    super(
      `"${matchText}" matches ${matches.length} bullets: ` +
        matches.map((m) => `line ${m.line}: "${m.text}"`).join('; ') +
        `. Pass a more specific matchText, or an "occurrence" (1-${matches.length}) to disambiguate.`
    );
    this.name = 'AmbiguousMatchError';
  }
}

interface ParsedOutlinerLine {
  index: number; // 0-based index into the body's lines array
  raw: string;
  isBullet: boolean;
  /** Only meaningful when isBullet is true. Existing app-written content is always an exact multiple of 4 spaces/level. */
  level: number;
  /** Only meaningful when isBullet is true: marker and checkbox stripped. */
  text: string;
}

function parseOutlinerLines(body: string): ParsedOutlinerLine[] {
  return body.split('\n').map((raw, index) => {
    if (raw.trim() === '') {
      return { index, raw, isBullet: false, level: 0, text: '' };
    }
    const trimmed = raw.trimStart();
    if (!BULLET_MARKER_RE.test(trimmed)) {
      return { index, raw, isBullet: false, level: 0, text: '' };
    }
    const afterMarker = trimmed.replace(BULLET_MARKER_RE, '');
    const afterCheckbox = afterMarker.replace(/^\[[ x/]\]\s*/i, '');
    return {
      index,
      raw,
      isBullet: true,
      level: Math.floor(leadingWidth(raw) / 4),
      text: afterCheckbox.trim()
    };
  });
}

/**
 * Inserts `addition` as new children (appended after any existing ones) of
 * a specific existing bullet, found by a case-insensitive substring match
 * against each bullet's own text (marker and checkbox stripped - matching
 * "IOmergent" against a bullet reading `- [[IOmergent]]` needs no special
 * wikilink handling, since the bracketed text already contains it as a
 * plain substring). Only applies to outliner notes.
 *
 * A bullet's children are the immediately-following lines with strictly
 * greater indent, stopping at the first line at or above its own level (or
 * end of note); blank lines inside that run don't end it, but the
 * insertion point is placed right after the last real content line, not
 * after any trailing blank gap.
 *
 * Known limitation: a fenced code block nested under a bullet is not
 * itself bullet-syntax, so it's treated as ending that bullet's children
 * block for insertion purposes (matches `normalizeOutlinerLines`' own
 * documented fence-handling limitation).
 */
export function insertUnderBullet(
  existingDoc: string,
  matchText: string,
  addition: string,
  opts?: { occurrence?: number }
): { doc: string; appended: string; matchedLine: number; matchedText: string } {
  if (detectNoteMode(existingDoc) !== 'outliner') {
    throw new NotOutlinerModeError();
  }
  if (typeof matchText !== 'string' || matchText.trim() === '') {
    throw new InvalidArgumentError('matchText must be a non-empty string');
  }

  const { frontmatter, content: body } = extractFrontmatter(existingDoc);
  const frontmatterRaw = frontmatter ? frontmatter.raw : null;

  const bodyLines = body.split('\n');
  const parsed = parseOutlinerLines(body);
  const needle = matchText.toLowerCase();
  const matches = parsed.filter((p) => p.isBullet && p.text.toLowerCase().includes(needle));

  if (matches.length === 0) {
    throw new BulletNotFoundError(matchText);
  }

  let chosen: ParsedOutlinerLine;
  if (matches.length === 1) {
    chosen = matches[0];
  } else {
    const occurrence = opts?.occurrence;
    if (
      occurrence === undefined ||
      !Number.isInteger(occurrence) ||
      occurrence < 1 ||
      occurrence > matches.length
    ) {
      throw new AmbiguousMatchError(
        matchText,
        matches.map((m) => ({ line: m.index + 1, text: m.text }))
      );
    }
    chosen = matches[occurrence - 1];
  }

  const parentLevel = chosen.level;
  let insertAfterIndex = chosen.index;
  for (let i = chosen.index + 1; i < parsed.length; i++) {
    const line = parsed[i];
    if (line.raw.trim() === '') continue; // blank line inside the children block: keep scanning
    if (line.isBullet && line.level > parentLevel) {
      insertAfterIndex = i;
      continue;
    }
    break; // a sibling/ancestor-level bullet, or a non-bullet line: children block ends here
  }

  const addLines = normalizeOutlinerLines(addition, parentLevel + 1);
  if (addLines.length === 0) {
    throw new InvalidArgumentError('content produced no bullets after normalization');
  }

  const newBodyLines = [
    ...bodyLines.slice(0, insertAfterIndex + 1),
    ...addLines,
    ...bodyLines.slice(insertAfterIndex + 1)
  ];
  let newBody = newBodyLines.join('\n');
  if (!newBody.endsWith('\n')) newBody += '\n';

  const doc = frontmatterRaw ? frontmatterRaw + '\n' + newBody : newBody;
  return {
    doc,
    appended: addLines.join('\n'),
    matchedLine: chosen.index + 1,
    matchedText: chosen.text
  };
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

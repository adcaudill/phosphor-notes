/**
 * Structural view of a note for MCP's outline/section tools - pure logic, no
 * filesystem dependency.
 *
 * A "section" is:
 *  - in a freeform note: a Markdown heading (`#` .. `######`, outside code
 *    fences) plus everything up to the next heading of the same or a higher
 *    level;
 *  - in an outliner note: a bullet plus everything nested under it.
 *
 * All line numbers are 1-based and count the WHOLE document, frontmatter
 * included - the same numbering read_note's line ranges and edit_note's
 * change report use.
 */
import { extractFrontmatter } from '../renderer/src/utils/frontmatterUtils';
import { detectNoteMode, normalizeOutlinerLines, InvalidArgumentError } from './noteFormat';
import type { NoteMode } from './noteFormat';

export type SectionKind = 'heading' | 'bullet';

export interface OutlineItem {
  /** 1-based line of the heading/bullet itself. */
  line: number;
  /** 1-based last line of the section (trailing blank lines not included). */
  endLine: number;
  /** Heading level (1-6), or bullet depth (1 = top level). */
  level: number;
  kind: SectionKind;
  /** Heading text without the #s, or bullet text without its marker/checkbox. */
  text: string;
}

export interface SectionLocator {
  /** Case-insensitive substring of the heading/bullet text. */
  match?: string;
  /** 1-based pick among several `match`es. */
  occurrence?: number;
  /** Exact line of the heading/bullet (from get_note_outline). */
  line?: number;
}

export type InsertPosition = 'first_child' | 'last_child' | 'before' | 'after';

export class SectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionNotFoundError';
  }
}

export class AmbiguousSectionError extends Error {
  constructor(
    public readonly matchText: string,
    public readonly matches: Array<{ line: number; text: string }>
  ) {
    super(
      `"${matchText}" matches ${matches.length} sections: ` +
        matches.map((m) => `line ${m.line}: "${m.text}"`).join('; ') +
        `. Use a more specific match, an "occurrence" (1-${matches.length}), or a "line".`
    );
    this.name = 'AmbiguousSectionError';
  }
}

interface Item extends OutlineItem {
  /** 0-based index of the heading/bullet line. */
  start: number;
  /** 0-based index of the last line of the section. */
  end: number;
  /** Leading whitespace width (bullets only; 0 for headings). */
  width: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET_MARKER_RE = /^[-*+](\s+|$)/;
const FENCE_RE = /^\s*(```|~~~)/;

function leadingWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

const isBlank = (line: string | undefined): boolean => line === undefined || line.trim() === '';

interface ParsedDoc {
  mode: NoteMode;
  lines: string[];
  /** 0-based index of the first body line (after any frontmatter). */
  bodyStart: number;
  items: Item[];
}

function splitLines(doc: string): string[] {
  const lines = doc.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.join('\n') + '\n';
}

function bodyStartIndex(doc: string): number {
  const { frontmatter } = extractFrontmatter(doc);
  if (!frontmatter) return 0;
  return frontmatter.raw.split('\n').length;
}

function parseHeadings(lines: string[], bodyStart: number): Item[] {
  const items: Item[] = [];
  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(HEADING_RE);
    if (m) {
      items.push({
        start: i,
        end: i,
        line: i + 1,
        endLine: i + 1,
        level: m[1].length,
        kind: 'heading',
        text: m[2],
        width: 0
      });
    }
  }
  for (let k = 0; k < items.length; k++) {
    const next = items.slice(k + 1).find((h) => h.level <= items[k].level);
    let end = next ? next.start - 1 : lines.length - 1;
    while (end > items[k].start && isBlank(lines[end])) end--;
    items[k].end = end;
    items[k].endLine = end + 1;
  }
  return items;
}

function parseBullets(lines: string[], bodyStart: number): Item[] {
  const items: Item[] = [];
  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || isBlank(line)) continue;
    const trimmed = line.trimStart();
    if (!BULLET_MARKER_RE.test(trimmed)) continue;
    const width = leadingWidth(line);
    const text = trimmed
      .replace(BULLET_MARKER_RE, '')
      .replace(/^\[[ x/]\]\s*/i, '')
      .trim();
    items.push({
      start: i,
      end: i,
      line: i + 1,
      endLine: i + 1,
      level: Math.floor(width / 4) + 1,
      kind: 'bullet',
      text,
      width
    });
  }
  for (const item of items) {
    let end = item.start;
    for (let j = item.start + 1; j < lines.length; j++) {
      const line = lines[j];
      if (isBlank(line)) continue;
      // Anything indented deeper than this bullet (child bullets, continuation
      // text, code blocks) belongs to it; the first line that isn't ends it.
      if (leadingWidth(line) <= item.width) break;
      end = j;
    }
    item.end = end;
    item.endLine = end + 1;
  }
  return items;
}

function parseDoc(doc: string): ParsedDoc {
  const mode = detectNoteMode(doc);
  const lines = splitLines(doc);
  const bodyStart = bodyStartIndex(doc);
  const items =
    mode === 'outliner' ? parseBullets(lines, bodyStart) : parseHeadings(lines, bodyStart);
  return { mode, lines, bodyStart, items };
}

/** The note's headings (freeform) or bullets (outliner), in document order. */
export function getOutline(doc: string): {
  mode: NoteMode;
  totalLines: number;
  items: OutlineItem[];
} {
  const parsed = parseDoc(doc);
  return {
    mode: parsed.mode,
    totalLines: parsed.lines.length,
    items: parsed.items.map(({ line, endLine, level, kind, text }) => ({
      line,
      endLine,
      level,
      kind,
      text
    }))
  };
}

function locate(parsed: ParsedDoc, locator: SectionLocator, role = 'section'): Item {
  const what = parsed.mode === 'outliner' ? 'bullet' : 'heading';
  const hasMatch = typeof locator.match === 'string' && locator.match.trim() !== '';
  const hasLine = typeof locator.line === 'number';
  if (hasMatch === hasLine) {
    throw new InvalidArgumentError(`identify the ${role} by exactly one of "match" or "line"`);
  }
  if (parsed.items.length === 0) {
    throw new SectionNotFoundError(
      parsed.mode === 'outliner'
        ? 'This note has no bullets.'
        : 'This note has no Markdown headings, so it has no sections to target. Use edit_note instead.'
    );
  }

  if (hasLine) {
    const item = parsed.items.find((it) => it.line === locator.line);
    if (!item) {
      throw new SectionNotFoundError(
        `Line ${locator.line} is not a ${what}. Use get_note_outline to find the right line.`
      );
    }
    return item;
  }

  const needle = locator.match!.toLowerCase();
  const matches = parsed.items.filter((it) => it.text.toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new SectionNotFoundError(`No ${what} matching "${locator.match}" was found.`);
  }
  if (matches.length === 1) return matches[0];
  const occ = locator.occurrence;
  if (occ === undefined || !Number.isInteger(occ) || occ < 1 || occ > matches.length) {
    throw new AmbiguousSectionError(
      locator.match!,
      matches.map((m) => ({ line: m.line, text: m.text }))
    );
  }
  return matches[occ - 1];
}

/** Replaces lines [from, to) with `block`; for freeform notes, keeps one blank line on each side of the block and none doubled at the seam. */
function splice(
  lines: string[],
  from: number,
  to: number,
  block: string[],
  freeform: boolean
): string[] {
  const before = lines.slice(0, from);
  const after = lines.slice(to);
  let mid = block;
  if (freeform) {
    if (mid.length > 0) {
      if (before.length > 0 && !isBlank(before[before.length - 1])) mid = ['', ...mid];
      if (after.length > 0 && !isBlank(after[0])) mid = [...mid, ''];
    } else {
      while (before.length > 0 && isBlank(before[before.length - 1]) && isBlank(after[0])) {
        after.shift();
      }
      // Removed the end of the note: don't leave it trailing blank lines.
      while (after.length === 0 && before.length > 0 && isBlank(before[before.length - 1])) {
        before.pop();
      }
    }
  }
  return [...before, ...mid, ...after];
}

function freeformBlock(content: string): string[] {
  const text = content.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return text === '' ? [] : text.split('\n');
}

function outlinerBlock(content: string, depth: number): string[] {
  return normalizeOutlinerLines(content.replace(/\r\n?/g, '\n'), depth);
}

export interface SectionEditResult {
  doc: string;
  /** The targeted heading/bullet, as it was before the edit. */
  section: { line: number; text: string };
  /** Text this edit discarded (for callers that must vet it), if any. */
  removedText?: string;
}

/** Replaces everything under a heading/bullet (keeping the heading/bullet line itself). Empty content clears it. */
export function replaceSectionBody(
  doc: string,
  locator: SectionLocator,
  content: string
): SectionEditResult {
  const parsed = parseDoc(doc);
  const item = locate(parsed, locator);
  const freeform = parsed.mode === 'freeform';
  const block = freeform ? freeformBlock(content) : outlinerBlock(content, item.level);
  const removed = parsed.lines.slice(item.start + 1, item.end + 1);
  const lines = splice(parsed.lines, item.start + 1, item.end + 1, block, freeform);
  return {
    doc: joinLines(lines),
    section: { line: item.line, text: item.text },
    removedText: removed.join('\n')
  };
}

/** Removes a heading and its whole section, or a bullet and everything nested under it. */
export function deleteSection(doc: string, locator: SectionLocator): SectionEditResult {
  const parsed = parseDoc(doc);
  const item = locate(parsed, locator);
  const removed = parsed.lines.slice(item.start, item.end + 1);
  const lines = splice(parsed.lines, item.start, item.end + 1, [], parsed.mode === 'freeform');
  return {
    doc: joinLines(lines),
    section: { line: item.line, text: item.text },
    removedText: removed.join('\n')
  };
}

/**
 * Inserts content relative to a heading/bullet: as its first or last child
 * (inside its section), or as a sibling just before or after the whole
 * section. Outliner content is re-formatted as bullets at the right depth;
 * freeform content is inserted as written (include your own subheading if
 * you want one).
 */
export function insertAtSection(
  doc: string,
  locator: SectionLocator,
  content: string,
  position: InsertPosition
): SectionEditResult & { insertedAtLine: number } {
  const parsed = parseDoc(doc);
  const item = locate(parsed, locator);
  const freeform = parsed.mode === 'freeform';
  const child = position === 'first_child' || position === 'last_child';
  const depth = child ? item.level : item.level - 1;
  const block = freeform ? freeformBlock(content) : outlinerBlock(content, depth);
  if (block.length === 0) {
    throw new InvalidArgumentError('content is empty after normalization');
  }
  // Inserting children into an outliner bullet fills any empty placeholder
  // bullets directly under it ("- " with no text or children of its own),
  // rather than leaving them above or below the new content.
  let source = parsed.lines;
  let end = item.end;
  if (!freeform && child) {
    const empties = new Set(
      parsed.items
        .filter(
          (it) =>
            it.start > item.start &&
            it.start <= item.end &&
            it.level === item.level + 1 &&
            it.text === '' &&
            it.end === it.start
        )
        .map((it) => it.start)
    );
    if (empties.size > 0) {
      source = source.filter((_, i) => !empties.has(i));
      end -= empties.size;
    }
  }
  const index =
    position === 'before' ? item.start : position === 'first_child' ? item.start + 1 : end + 1;
  const lines = splice(source, index, index, block, freeform);
  const insertedAtLine = lines.indexOf(block[0], index) + 1;
  return {
    doc: joinLines(lines),
    section: { line: item.line, text: item.text },
    insertedAtLine
  };
}

function relevel(block: string[], delta: number, freeform: boolean): string[] {
  if (delta === 0) return block;
  if (!freeform) {
    return block.map((line) => {
      if (isBlank(line)) return line;
      if (delta > 0) return ' '.repeat(delta * 4) + line;
      let toRemove = -delta * 4;
      let i = 0;
      while (toRemove > 0 && i < line.length && (line[i] === ' ' || line[i] === '\t')) {
        toRemove -= line[i] === '\t' ? 4 : 1;
        i++;
      }
      return line.slice(i);
    });
  }
  let inFence = false;
  return block.map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    const m = !inFence && line.match(/^(#{1,6})(\s.*)$/);
    if (!m) return line;
    const level = m[1].length + delta;
    if (level > 6) {
      throw new InvalidArgumentError(
        'moving this section there would need headings deeper than ######'
      );
    }
    return '#'.repeat(Math.max(1, level)) + m[2];
  });
}

/**
 * Moves a section (heading + content, or bullet + children) to a new place in
 * the same note, relative to another section. The moved section is
 * re-levelled to fit: bullets are re-indented, heading levels shifted.
 */
export function moveSection(
  doc: string,
  source: SectionLocator,
  target: SectionLocator,
  position: InsertPosition
): SectionEditResult & { target: { line: number; text: string }; movedToLine: number } {
  const parsed = parseDoc(doc);
  const freeform = parsed.mode === 'freeform';
  const src = locate(parsed, source, 'section to move');
  const tgt = locate(parsed, target, 'target section');
  if (tgt.start >= src.start && tgt.start <= src.end) {
    throw new InvalidArgumentError(
      'the target is the section being moved, or inside it - choose a target outside it'
    );
  }

  const child = position === 'first_child' || position === 'last_child';
  const newLevel = child ? tgt.level + 1 : tgt.level;
  const block = relevel(parsed.lines.slice(src.start, src.end + 1), newLevel - src.level, freeform);

  const insertAt =
    position === 'before' ? tgt.start : position === 'first_child' ? tgt.start + 1 : tgt.end + 1;

  // Remove the source, keeping the insertion index pointing at the same place.
  let lines = [...parsed.lines.slice(0, src.start), ...parsed.lines.slice(src.end + 1)];
  let index = insertAt > src.end ? insertAt - (src.end - src.start + 1) : insertAt;
  if (freeform) {
    const seam = src.start;
    if (seam > 0 && isBlank(lines[seam - 1]) && seam < lines.length && isBlank(lines[seam])) {
      lines.splice(seam, 1);
      if (index > seam) index--;
    }
    // Moved the note's last section away: drop the blank lines it leaves at the end.
    if (seam >= lines.length) {
      while (lines.length > 0 && isBlank(lines[lines.length - 1]) && index < lines.length) {
        lines.pop();
      }
    }
  }
  lines = splice(lines, index, index, block, freeform);
  const movedToLine = lines.indexOf(block[0], index) + 1;

  return {
    doc: joinLines(lines),
    section: { line: src.line, text: src.text },
    target: { line: tgt.line, text: tgt.text },
    movedToLine
  };
}

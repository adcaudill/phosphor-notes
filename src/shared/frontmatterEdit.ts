/**
 * Targeted frontmatter edits for MCP's update_frontmatter: change individual
 * keys and tags while leaving every other line of the frontmatter - and the
 * whole note body - byte-for-byte as it was. Pure logic, no filesystem.
 *
 * The app's own parser (renderer/src/utils/frontmatterUtils.ts) only reads
 * flat `key: value` lines, so that's all this writes; existing multi-line
 * values (an indented YAML list, say) are kept intact unless that exact key
 * is being changed, in which case its whole block is replaced.
 */
import { InvalidArgumentError } from './noteFormat';

export type FrontmatterValue = string | number | boolean | string[];

export interface FrontmatterEdit {
  /** Keys to add or replace. */
  set?: Record<string, FrontmatterValue>;
  /** Keys to remove. */
  remove?: string[];
  addTags?: string[];
  removeTags?: string[];
}

export interface FrontmatterEditResult {
  doc: string;
  /** Tags after the edit. */
  tags: string[];
  /** Every key line (with its continuation lines) this edit replaced or removed, for callers that must vet discarded text. */
  replacedText: string[];
  /** Keys set, removed, or (for "tags") rewritten. */
  keysChanged: string[];
}

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const KEY_LINE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:(.*)$/;
/** Keys whose meaning a plain value change would break. */
const PROTECTED_KEYS = new Set(['mode']);

interface Block {
  key: string | null; // null for lines that aren't (part of) a top-level key: comments, blanks, junk
  lines: string[];
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (const line of lines) {
    const m = line.match(KEY_LINE_RE);
    if (m) {
      blocks.push({ key: m[1], lines: [line] });
    } else if (/^\s+\S|^\s*-\s/.test(line) && blocks.length > 0 && blocks[blocks.length - 1].key) {
      // Indented line or YAML list item: a continuation of the previous key's value.
      blocks[blocks.length - 1].lines.push(line);
    } else {
      blocks.push({ key: null, lines: [line] });
    }
  }
  return blocks;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseTags(block: Block | undefined): string[] {
  if (!block) return [];
  const first = block.lines[0].replace(KEY_LINE_RE, '$2').trim();
  let items: string[];
  if (first.startsWith('[') && first.endsWith(']')) {
    items = first.slice(1, -1).split(',');
  } else if (first !== '') {
    items = first.split(',');
  } else {
    items = block.lines.slice(1).map((l) => l.replace(/^\s*-\s*/, ''));
  }
  return items.map((t) => unquote(t).replace(/^#/, '').trim()).filter((t) => t.length > 0);
}

function needsQuoting(s: string): boolean {
  return (
    s === '' ||
    s !== s.trim() ||
    /[:#,[\]{}]/.test(s) ||
    /^[-?|>!%@`&*"']/.test(s) ||
    /^(true|false|null|yes|no|~)$/i.test(s)
  );
}

function formatScalar(s: string): string {
  return needsQuoting(s) ? JSON.stringify(s) : s;
}

function formatValue(key: string, value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatScalar(String(v))).join(', ')}]`;
  }
  if (typeof value === 'string') {
    if (/[\r\n]/.test(value)) {
      throw new InvalidArgumentError(`frontmatter value for "${key}" must be a single line`);
    }
    return formatScalar(value);
  }
  return String(value);
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new InvalidArgumentError(
      `"${key}" is not a valid frontmatter key (letters, digits, and underscores; not starting with a digit)`
    );
  }
  if (PROTECTED_KEYS.has(key)) {
    throw new InvalidArgumentError(
      `"${key}" can't be changed here: switching a note between outliner and freeform doesn't ` +
        'convert its body, so the note would no longer match its own format.'
    );
  }
}

export function updateFrontmatter(doc: string, edit: FrontmatterEdit): FrontmatterEditResult {
  const set = edit.set ?? {};
  const remove = edit.remove ?? [];
  for (const key of [...Object.keys(set), ...remove]) validateKey(key);
  if (Object.keys(set).includes('tags') && (edit.addTags?.length || edit.removeTags?.length)) {
    throw new InvalidArgumentError('set "tags" directly, or use addTags/removeTags, but not both');
  }
  const overlap = remove.find((k) => k in set);
  if (overlap) throw new InvalidArgumentError(`"${overlap}" is both set and removed`);

  // Split off the frontmatter exactly as the app's extractFrontmatter does.
  let fmLines: string[] = [];
  let body = doc;
  if (doc.startsWith('---')) {
    const end = doc.indexOf('\n---', 3);
    if (end !== -1) {
      fmLines = doc.slice(doc.indexOf('\n') + 1, end + 1).split('\n');
      if (fmLines[fmLines.length - 1] === '') fmLines.pop();
      let bodyStart = end + 4;
      if (doc[bodyStart] === '\n') bodyStart += 1;
      body = doc.slice(bodyStart);
    }
  }

  const blocks = parseBlocks(fmLines);
  const blockFor = (key: string): Block | undefined => blocks.find((b) => b.key === key);
  const replacedText: string[] = [];
  const keysChanged: string[] = [];

  const replaceBlock = (key: string, newLine: string | null): void => {
    const existing = blockFor(key);
    if (existing) {
      replacedText.push(existing.lines.join('\n'));
      if (newLine === null) {
        blocks.splice(blocks.indexOf(existing), 1);
      } else {
        existing.lines = [newLine];
      }
    } else if (newLine !== null) {
      blocks.push({ key, lines: [newLine] });
    }
    keysChanged.push(key);
  };

  for (const [key, value] of Object.entries(set)) {
    replaceBlock(key, `${key}: ${formatValue(key, value)}`);
  }
  for (const key of remove) {
    if (blockFor(key)) replaceBlock(key, null);
  }

  let tags = parseTags(blockFor('tags'));
  if (edit.addTags?.length || edit.removeTags?.length) {
    const clean = (t: string): string => t.trim().replace(/^#/, '');
    const removeSet = new Set((edit.removeTags ?? []).map((t) => clean(t).toLowerCase()));
    const next = tags.filter((t) => !removeSet.has(t.toLowerCase()));
    for (const raw of edit.addTags ?? []) {
      const t = clean(raw);
      if (/[\r\n]/.test(t)) throw new InvalidArgumentError('tags must be single-line');
      if (t && !next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    }
    tags = next;
    replaceBlock('tags', next.length > 0 ? `tags: ${formatValue('tags', next)}` : null);
  }

  const newFmLines = blocks.flatMap((b) => b.lines);
  let nextDoc: string;
  if (newFmLines.length === 0 && fmLines.length === 0) {
    nextDoc = doc; // nothing to write and there was no frontmatter: leave the note alone
  } else {
    nextDoc = `---\n${newFmLines.join('\n')}${newFmLines.length ? '\n' : ''}---\n${body}`;
  }

  return { doc: nextDoc, tags, replacedText, keysChanged };
}

/**
 * Exact (literal) text matching shared by MCP's find_text and edit_note:
 * optional case-insensitivity, whole-word matching, and knowing whether a
 * match falls inside a [[wikilink]]. Deliberately literal-only - no regular
 * expressions - so a pathological pattern can never hang the main process.
 */

export interface MatchOptions {
  /** Default true. */
  caseSensitive?: boolean;
  /** Only match where the text isn't directly preceded/followed by a letter or digit. */
  wholeWord?: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * Start offsets of every non-overlapping occurrence of `needle` in `haystack`.
 * Whole-word checks look at the characters around each candidate, so
 * "Abigail" doesn't match inside "Abigails" (but does match "Abigail's").
 */
export function findOccurrences(
  haystack: string,
  needle: string,
  opts: MatchOptions = {}
): number[] {
  if (needle === '') return [];
  const caseSensitive = opts.caseSensitive !== false;
  const hay = caseSensitive ? haystack : haystack.toLowerCase();
  const ndl = caseSensitive ? needle : needle.toLowerCase();
  // Lower-casing can change string length for a few characters; fall back to
  // case-sensitive offsets in that rare case rather than report wrong ones.
  const useLowered = caseSensitive || hay.length === haystack.length;
  const h = useLowered ? hay : haystack;
  const n = useLowered ? ndl : needle;

  const out: number[] = [];
  for (let i = h.indexOf(n); i !== -1;) {
    const ok =
      !opts.wholeWord ||
      (!(isWordChar(n[0]) && isWordChar(haystack[i - 1])) &&
        !(isWordChar(n[n.length - 1]) && isWordChar(haystack[i + n.length])));
    if (ok) {
      out.push(i);
      i = h.indexOf(n, i + n.length);
    } else {
      i = h.indexOf(n, i + 1);
    }
  }
  return out;
}

/** [start, end) offsets of every [[wikilink]] (including its brackets) in `text`. */
export function wikilinkSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\[\[[^\]\n]*?\]\]/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** True if [start, start+length) overlaps any of `spans`. */
export function overlapsAny(
  start: number,
  length: number,
  spans: Array<[number, number]>
): boolean {
  const end = start + length;
  return spans.some(([s, e]) => start < e && end > s);
}

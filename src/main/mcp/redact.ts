/**
 * Masks sensitive PII in everything handed back to an MCP client, so note
 * contents containing a US Social Security number or a payment card number
 * never reach an AI tool verbatim. Applied at the single output choke point
 * (`toCallToolResult` / `toErrorResult`), so every tool - present and
 * future - is covered without each one having to remember to call it.
 *
 * Detection deliberately errs toward masking: any SSN-shaped value is
 * masked regardless of whether its area/group numbers are ones the SSA
 * would actually issue. Card numbers additionally require a passing Luhn
 * checksum, since bare 15/16 digit runs (IDs, timestamps, hashes) are
 * common in notes and a number failing the checksum can't be a real card.
 */

export const SSN_MASK = '[REDACTED SSN]';
export const CARD_MASK = '[REDACTED CARD]';

// NNN-NN-NNNN or NNN NN NNNN, with the same separator used both times.
const SSN_PATTERN = /(?<!\d)\d{3}([- ])\d{2}\1\d{4}(?!\d)/g;

// 16 digits as 4-4-4-4 or 15 as 4-6-5 (Amex), with a consistent space or
// hyphen separator, or 15-16 contiguous digits. The candidate is captured
// inside a lookahead so matches don't consume text: in a run like
// "1234 4111 1111 1111 1111" a leading window that fails Luhn must not
// swallow the start of the real card number that follows it.
const CARD_PATTERN =
  /(?<!\d)(?=(\d{4}([- ])\d{4}\2\d{4}\2\d{4}|\d{4}([- ])\d{6}\3\d{5}|\d{15,16})(?!\d))/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactCards(text: string): string {
  // Collect every Luhn-valid candidate span, then mask them, merging any
  // that overlap so no digits from either survive.
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(CARD_PATTERN)) {
    const candidate = m[1];
    if (passesLuhn(candidate.replace(/[- ]/g, ''))) {
      spans.push([m.index, m.index + candidate.length]);
    }
  }
  if (spans.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start >= cursor) {
      out += text.slice(cursor, start) + CARD_MASK;
    }
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}

/** Returns `text` with any SSN- or card-number-looking values masked. */
export function redactText(text: string): string {
  // SSNs first: an SSN's trailing digit group sitting next to a card number
  // could otherwise be read as the first group of a card candidate.
  return redactCards(text.replace(SSN_PATTERN, SSN_MASK));
}

/**
 * Deep-copies `value`, masking every string (including object keys, which
 * can carry note paths or titles) via `redactText`. Non-string leaves are
 * returned as-is.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[redactText(key)] = redactValue(item);
    }
    return out as T;
  }
  return value;
}

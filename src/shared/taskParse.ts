/**
 * Plain-language task input -> task fields, locally and deterministically.
 *
 *   "pay rent on the first of each month !high #bills +Home"
 *   -> title "pay rent", due = next 1st, repeat monthly on the 1st,
 *      priority high, tags [bills], project Home
 *
 * Pieces it recognizes (each is removed from the title and reported as a
 * token, so the UI can highlight it and preview the result):
 *
 *   dates      "fri", "tomorrow at 3pm", "dec 4", "in 3 days", "next week"
 *              (chrono-node); "start fri" / "from fri" sets the start date
 *   repeats    "daily", "every 2 weeks on mon and thu", "every weekday",
 *              "on the first of each month", "the last friday of the month",
 *              "every year on mar 3", "every 3 days after done",
 *              plus "until jun 30" and "10 times"
 *   priority   !high !med !low, or !!! !! !
 *   tags       #tag
 *   project    +Project or +"Multi Word"
 *   waiting    "waiting on <who>"
 *
 * Anything in double quotes is kept as title text and never parsed - which
 * is also how the UI "un-parses" a token. Ambiguous words only count as
 * dates in context: "sat"/"sun" need "on"/"by"/"due" (or the full name), and
 * a month on its own needs "in"/"by"/"until" ("march on" stays a title).
 *
 * Nothing here is ever applied to saved text; it only turns what someone
 * types into fields.
 */
import * as chrono from 'chrono-node';
import type { TaskPriority, TaskRepeat } from './taskRecord';
import { localDate } from './taskRecord';
import { monthlyOnDayRule, upcomingOccurrences } from './taskRepeat';
import type { NewTaskInput } from './taskOps';

export type TokenKind =
  'due' | 'start' | 'repeat' | 'until' | 'count' | 'priority' | 'tag' | 'project' | 'waiting';

export interface ParsedToken {
  kind: TokenKind;
  /** Offsets into the original input. */
  start: number;
  end: number;
  /** The original text of the token. */
  text: string;
}

export interface ParsedTaskInput {
  title: string;
  due?: string;
  start?: string;
  repeat?: TaskRepeat;
  priority?: TaskPriority;
  tags: string[];
  project?: string;
  waitingOn?: string;
  tokens: ParsedToken[];
  /** Things worth telling the person about the interpretation. */
  notes: string[];
}

export interface ParseOptions {
  /** "Now" for relative dates. */
  now?: Date;
  /** How to read numeric dates like 4/12: month first (US) or day first. */
  dateOrder?: 'mdy' | 'dmy';
}

// ---------------------------------------------------------------------------
// Vocabulary

const WD_SRC =
  'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const WD_LIST_SRC = `(?:${WD_SRC})(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)(?:${WD_SRC}))*`;
const MONTH_SRC =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ORD_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
};
const DAY_ORD_SRC = `(?:\\d{1,2}(?:st|nd|rd|th)?|${Object.keys(ORD_WORDS).join('|')})`;
const POS_SRC = 'first|second|third|fourth|last';
const AFTER_DONE_SRC =
  "(?:\\s+after\\s+(?:it(?:'s|\\s+is)\\s+)?(?:done|completion|completed|complete|finished))";

function weekdayCode(word: string): string {
  const w = word.toLowerCase();
  if (w.startsWith('mon')) return 'MO';
  if (w.startsWith('tue')) return 'TU';
  if (w.startsWith('wed')) return 'WE';
  if (w.startsWith('thu')) return 'TH';
  if (w.startsWith('fri')) return 'FR';
  if (w.startsWith('sat')) return 'SA';
  return 'SU';
}

function weekdayList(src: string): string {
  const codes: string[] = [];
  for (const m of src.matchAll(new RegExp(WD_SRC, 'gi'))) {
    const c = weekdayCode(m[0]);
    if (!codes.includes(c)) codes.push(c);
  }
  const order = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  return codes.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(',');
}

function monthNumber(word: string): number {
  const names = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec'
  ];
  return names.indexOf(word.toLowerCase().slice(0, 3)) + 1;
}

function dayNumber(word: string): number {
  const w = word.toLowerCase();
  return ORD_WORDS[w] ?? parseInt(w, 10);
}

function posNumber(word: string): number {
  const w = word.toLowerCase();
  return w === 'last' ? -1 : ORD_WORDS[w];
}

// ---------------------------------------------------------------------------
// Repeats

interface RepeatMatch {
  start: number;
  end: number;
  rule: string;
  from: 'due' | 'completion';
  /** A monthly rule still to be anchored on the first due date's day. */
  anchorMonthly?: number;
}

/** "on the 15th" / "on the last day" / "on the first monday" / "on mon and thu" / "on mar 3", for a unit. */
function onClauseRule(freq: string, interval: number, clause: string): string | null {
  const every = interval > 1 ? `;INTERVAL=${interval}` : '';
  const c = clause.trim().replace(/^the\s+/i, '');
  let m: RegExpExecArray | null;
  if (freq === 'WEEKLY' && (m = new RegExp(`^(${WD_LIST_SRC})$`, 'i').exec(c))) {
    return `FREQ=WEEKLY${every};BYDAY=${weekdayList(m[1])}`;
  }
  if (freq === 'MONTHLY') {
    if (/^last\s+day(?:\s+of\s+the\s+month)?$/i.test(c))
      return `FREQ=MONTHLY${every};BYMONTHDAY=-1`;
    if (/^last\s+weekday$/i.test(c)) return `FREQ=MONTHLY${every};BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1`;
    if ((m = new RegExp(`^(${POS_SRC})\\s+(${WD_SRC})$`, 'i').exec(c))) {
      return `FREQ=MONTHLY${every};BYDAY=${posNumber(m[1])}${weekdayCode(m[2])}`;
    }
    if ((m = new RegExp(`^(${DAY_ORD_SRC})$`, 'i').exec(c))) {
      const day = dayNumber(m[1]);
      if (day >= 1 && day <= 31) return monthlyOnDayRule(day, interval);
    }
  }
  if (freq === 'YEARLY' && (m = new RegExp(`^(${MONTH_SRC})\\s+(${DAY_ORD_SRC})$`, 'i').exec(c))) {
    const day = dayNumber(m[2]);
    if (day >= 1 && day <= 31)
      return `FREQ=YEARLY${every};BYMONTH=${monthNumber(m[1])};BYMONTHDAY=${day}`;
  }
  return null;
}

const UNIT_FREQ: Record<string, string> = {
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
  year: 'YEARLY'
};

function findRepeat(text: string): RepeatMatch | null {
  const candidates: RepeatMatch[] = [];
  let m: RegExpExecArray | null;

  // every [other|N] day/week/month/year [on ...] [after done]
  const unitRe = new RegExp(
    `\\b(?:every|each)\\s+(?:(other)\\s+|(\\d{1,3})\\s+)?(day|week|month|year)s?\\b(?:\\s+on\\s+((?:the\\s+)?(?:${WD_LIST_SRC}|${DAY_ORD_SRC}|last\\s+day|last\\s+weekday|(?:${POS_SRC})\\s+(?:${WD_SRC})|(?:${MONTH_SRC})\\s+${DAY_ORD_SRC})))?(${AFTER_DONE_SRC})?`,
    'gi'
  );
  while ((m = unitRe.exec(text)) !== null) {
    const interval = m[1] ? 2 : m[2] ? Math.max(1, parseInt(m[2], 10)) : 1;
    const freq = UNIT_FREQ[m[3].toLowerCase()];
    const from = m[5] ? 'completion' : 'due';
    let rule: string | null = null;
    let anchorMonthly: number | undefined;
    if (m[4] && from === 'due') rule = onClauseRule(freq, interval, m[4]);
    if (!rule) {
      rule = `FREQ=${freq}${interval > 1 ? `;INTERVAL=${interval}` : ''}`;
      if (freq === 'MONTHLY' && from === 'due') anchorMonthly = interval;
    }
    candidates.push({ start: m.index, end: m.index + m[0].length, rule, from, anchorMonthly });
  }

  // every weekday / weekdays
  const weekdayRe = new RegExp(`\\b(?:every|each)\\s+weekday\\b|\\bweekdays\\b`, 'gi');
  while ((m = weekdayRe.exec(text)) !== null) {
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      from: 'due'
    });
  }

  // every [other] mon and thu
  const everyDayRe = new RegExp(`\\b(?:every|each)\\s+(other\\s+)?(${WD_LIST_SRC})\\b`, 'gi');
  while ((m = everyDayRe.exec(text)) !== null) {
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      rule: `FREQ=WEEKLY${m[1] ? ';INTERVAL=2' : ''};BYDAY=${weekdayList(m[2])}`,
      from: 'due'
    });
  }

  // daily / weekly [on mon] / monthly [on the 15th] / yearly|annually [on mar 3]
  const adverbRe = new RegExp(
    `\\b(daily|weekly|monthly|yearly|annually)\\b(?:\\s+on\\s+((?:the\\s+)?(?:${WD_LIST_SRC}|${DAY_ORD_SRC}|last\\s+day|last\\s+weekday|(?:${POS_SRC})\\s+(?:${WD_SRC})|(?:${MONTH_SRC})\\s+${DAY_ORD_SRC})))?(${AFTER_DONE_SRC})?`,
    'gi'
  );
  while ((m = adverbRe.exec(text)) !== null) {
    const word = m[1].toLowerCase();
    const freq =
      word === 'daily'
        ? 'DAILY'
        : word === 'weekly'
          ? 'WEEKLY'
          : word === 'monthly'
            ? 'MONTHLY'
            : 'YEARLY';
    const from = m[3] ? 'completion' : 'due';
    const rule = (m[2] && from === 'due' ? onClauseRule(freq, 1, m[2]) : null) ?? `FREQ=${freq}`;
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      rule,
      from,
      anchorMonthly: rule === 'FREQ=MONTHLY' && from === 'due' ? 1 : undefined
    });
  }

  // [on] the 15th / first / last day of each month
  const dayOfMonthRe = new RegExp(
    `\\b(?:on\\s+)?the\\s+(${DAY_ORD_SRC}|last\\s+day|last\\s+weekday)\\s+of\\s+(?:each|every|the)\\s+month\\b`,
    'gi'
  );
  while ((m = dayOfMonthRe.exec(text)) !== null) {
    const rule = onClauseRule('MONTHLY', 1, m[1]);
    if (rule) candidates.push({ start: m.index, end: m.index + m[0].length, rule, from: 'due' });
  }

  // [on] the first/last friday of each month
  const posDayRe = new RegExp(
    `\\b(?:on\\s+)?the\\s+(${POS_SRC})\\s+(${WD_SRC})\\s+of\\s+(?:each|every|the)\\s+month\\b`,
    'gi'
  );
  while ((m = posDayRe.exec(text)) !== null) {
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      rule: `FREQ=MONTHLY;BYDAY=${posNumber(m[1])}${weekdayCode(m[2])}`,
      from: 'due'
    });
  }

  // every mar 3
  const everyDateRe = new RegExp(
    `\\b(?:every|each)\\s+(${MONTH_SRC})\\s+(${DAY_ORD_SRC})\\b`,
    'gi'
  );
  while ((m = everyDateRe.exec(text)) !== null) {
    const day = dayNumber(m[2]);
    if (day >= 1 && day <= 31) {
      candidates.push({
        start: m.index,
        end: m.index + m[0].length,
        rule: `FREQ=YEARLY;BYMONTH=${monthNumber(m[1])};BYMONTHDAY=${day}`,
        from: 'due'
      });
    }
  }

  if (candidates.length === 0) return null;
  // The longest match wins (it says the most), then the earliest.
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Parsing

interface Span {
  start: number;
  end: number;
}

/** Replaces spans with spaces (same length), so later passes don't re-read them but offsets stay put. */
function blank(text: string, spans: Span[]): string {
  let out = text;
  for (const s of spans)
    out = out.slice(0, s.start) + ' '.repeat(s.end - s.start) + out.slice(s.end);
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function componentsDate(c: chrono.ParsedComponents): string {
  return `${c.get('year')}-${pad(c.get('month') ?? 1)}-${pad(c.get('day') ?? 1)}`;
}

/** Words immediately before `index` in `text` (lowercase), nearest last. */
function wordsBefore(text: string, index: number, count = 2): string[] {
  const before = text.slice(0, index).trimEnd();
  const words = before.split(/\s+/).filter(Boolean);
  return words.slice(-count).map((w) => w.toLowerCase());
}

const DUE_WORDS = new Set(['due', 'by', 'on', 'before', 'at']);
const START_WORDS = new Set([
  'start',
  'starts',
  'starting',
  'from',
  'begin',
  'begins',
  'beginning'
]);
const UNTIL_WORDS = new Set(['until', 'till', 'til', 'through']);
const CONTEXT_WORDS = new Set([...DUE_WORDS, ...START_WORDS, ...UNTIL_WORDS, 'next', 'this', 'in']);

/** Rejects date readings of words that are usually just words. */
function acceptDate(result: chrono.ParsedResult, text: string): boolean {
  const t = result.text.trim().toLowerCase();
  const prev = wordsBefore(text, result.index, 1)[0] ?? '';
  const hasContext = CONTEXT_WORDS.has(prev) || /^(on|by|next|this|in)\s/.test(t);
  // "sat" (as in "sat with") and "sun" alone need context.
  if (/^(sat|sun)$/.test(t)) return hasContext;
  // A month on its own ("march on", "may") needs context.
  if (new RegExp(`^(${MONTH_SRC})$`).test(t))
    return ['in', 'by', 'until', 'till', 'before', 'due'].includes(prev);
  // A bare number or a time-only reading with nothing else isn't a date.
  if (/^\d{1,2}$/.test(t)) return false;
  return true;
}

export function parseTaskInput(input: string, opts: ParseOptions = {}): ParsedTaskInput {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const tokens: ParsedToken[] = [];
  const notes: string[] = [];
  const consumed: Span[] = [];
  const take = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({ kind, start, end, text: input.slice(start, end) });
    consumed.push({ start, end });
  };

  // Quoted text is title, never parsed.
  const quoted: Span[] = [];
  for (const m of input.matchAll(/"[^"]*"/g))
    quoted.push({ start: m.index, end: m.index + m[0].length });
  const work = (): string => blank(input, [...quoted, ...consumed]);

  const result: ParsedTaskInput = { title: '', tags: [], tokens, notes };

  // Priority
  {
    const m = /(^|\s)(!high|!medium|!med|!low|!!!|!!|!)(?=\s|$)/i.exec(work());
    if (m) {
      const word = m[2].toLowerCase();
      result.priority =
        word === '!high' || word === '!!!'
          ? 'high'
          : word === '!low' || word === '!'
            ? 'low'
            : 'medium';
      take('priority', m.index + m[1].length, m.index + m[0].length);
    }
  }
  // Tags
  for (const m of work().matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    const tag = m[2];
    if (!result.tags.includes(tag)) result.tags.push(tag);
    take('tag', m.index + m[1].length, m.index + m[0].length);
  }
  // Project: +Name, or +"Multi Word" (read from the input, since quotes are blanked for parsing)
  {
    const quotedProject = /(^|\s)\+"([^"]+)"/.exec(input);
    if (quotedProject) {
      const start = quotedProject.index + quotedProject[1].length;
      const end = quotedProject.index + quotedProject[0].length;
      result.project = quotedProject[2].trim();
      // It's no longer title text: drop it from the quoted spans and consume it.
      const qi = quoted.findIndex((q) => q.start === start + 1);
      if (qi !== -1) quoted.splice(qi, 1);
      take('project', start, end);
    } else {
      const m = /(^|\s)\+([\p{L}][\p{L}\p{N}_/-]*)/u.exec(work());
      if (m) {
        result.project = m[2];
        take('project', m.index + m[1].length, m.index + m[0].length);
      }
    }
  }

  // Repeat
  const repeat = findRepeat(work());
  if (repeat) take('repeat', repeat.start, repeat.end);

  // Count ("10 times") - only meaningful with a repeat
  if (repeat) {
    const m = /\b(?:for\s+)?(\d{1,4})\s+times\b/i.exec(work());
    if (m) {
      result.repeat = { rule: repeat.rule, from: repeat.from, count: parseInt(m[1], 10) };
      take('count', m.index, m.index + m[0].length);
    }
  }

  // Dates
  const parser = opts.dateOrder === 'dmy' ? chrono.en.GB : chrono.en;
  const dateText = work();
  let until: string | undefined;
  for (const r of parser.parse(dateText, now, { forwardDate: true })) {
    if (!acceptDate(r, dateText)) continue;
    const prev = wordsBefore(dateText, r.index, 1)[0] ?? '';
    // Pull a leading keyword ("due fri", "start mon", "until jun 30") into the token.
    let start = r.index;
    const keyword = /(\S+)\s*$/.exec(dateText.slice(0, r.index));
    const absorbKeyword = (): void => {
      if (keyword) start = keyword.index;
    };
    const date = componentsDate(r.start);
    const time = r.start.isCertain('hour')
      ? `T${pad(r.start.get('hour') ?? 0)}:${pad(r.start.get('minute') ?? 0)}`
      : '';

    if (START_WORDS.has(prev) && !result.start) {
      absorbKeyword();
      result.start = date;
      take('start', start, r.index + r.text.length);
    } else if (UNTIL_WORDS.has(prev) && repeat && !until) {
      absorbKeyword();
      until = date;
      take('until', start, r.index + r.text.length);
    } else if (!result.due) {
      if (DUE_WORDS.has(prev) || UNTIL_WORDS.has(prev) || prev === 'in') absorbKeyword();
      result.due = date + time;
      take('due', start, r.index + r.text.length);
    }
  }

  // Waiting on someone: "waiting on Alice" / "waiting for the quote"
  // (Read from the blanked text, so tags/dates already taken aren't swallowed.)
  {
    const w = work().replace(/\s+$/, '');
    const m = /\bwaiting\s+(?:on|for)\s+(\S.*)$/i.exec(w);
    if (m) {
      const who = m[1].replace(/\s+/g, ' ').trim();
      if (who) {
        result.waitingOn = who;
        take('waiting', m.index, m.index + m[0].length);
      }
    }
  }

  // Assemble the repeat, anchoring it on the first due date.
  if (repeat) {
    let rule = repeat.rule;
    let due = result.due;
    if (repeat.from === 'completion') {
      if (/BY(DAY|MONTHDAY|MONTH|SETPOS)=/.test(rule)) {
        notes.push('repeats counted from completion ignore the day of the week or month');
      }
      due ??= today;
    } else if (repeat.anchorMonthly) {
      due ??= today;
      rule = monthlyOnDayRule(Number(due.slice(8, 10)), repeat.anchorMonthly);
    } else if (!due) {
      // The first matching day on or after today. Without INTERVAL: rrule
      // counts "every 2 weeks" from the week the search starts in, which could
      // skip the nearest Tuesday; later occurrences count from this due date.
      const firstRule = rule.replace(/;INTERVAL=\d+/, '');
      due = /BY(DAY|MONTHDAY|MONTH)=/.test(rule)
        ? (upcomingOccurrences(firstRule, today, 1)[0] ?? today)
        : today;
    }
    result.due = due;
    result.repeat = {
      rule,
      from: repeat.from,
      ...(until ? { until } : {}),
      ...(result.repeat?.count !== undefined ? { count: result.repeat.count } : {})
    };
  }

  // Title: what's left, minus connecting words stranded next to removed pieces.
  let title = input;
  const removed = [...consumed].sort((a, b) => b.start - a.start);
  for (const s of removed) title = title.slice(0, s.start) + ' ' + title.slice(s.end);
  title = title
    .replace(/"([^"]*)"/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const STRANDED = /^(?:on|by|due|at|from|starting|start|until|till|and|every|each)$/i;
  let words = title.split(' ').filter(Boolean);
  while (words.length > 1 && STRANDED.test(words[words.length - 1])) words = words.slice(0, -1);
  title = words
    .join(' ')
    .replace(/[,;:-]+$/, '')
    .trim();
  result.title = title;

  tokens.sort((a, b) => a.start - b.start);
  return result;
}

/**
 * A date field on its own ("fri", "dec 4", "tomorrow at 3pm", "2026-12-01"):
 * the date (with a time if one was given), or null if it doesn't read as one.
 * Unlike free text, any date reading counts here - "sat" in a date field
 * means Saturday.
 */
export function parseDatePhrase(text: string, opts: ParseOptions = {}): string | null {
  const t = text.trim();
  if (!t) return null;
  const parser = opts.dateOrder === 'dmy' ? chrono.en.GB : chrono.en;
  const r = parser.parse(t, opts.now ?? new Date(), { forwardDate: true })[0];
  if (!r) return null;
  const time = r.start.isCertain('hour')
    ? `T${pad(r.start.get('hour') ?? 0)}:${pad(r.start.get('minute') ?? 0)}`
    : '';
  return componentsDate(r.start) + time;
}

/**
 * A repeat field on its own ("monthly on the 15th", "every mon and thu",
 * "2 weeks", "every 3 days after done"). `due` anchors repeats that need a
 * day ("monthly" -> on the due date's day). Returns the repeat and the first
 * due date it implies, or null if it doesn't read as a repeat.
 */
export function parseRepeatPhrase(
  text: string,
  opts: ParseOptions & { due?: string } = {}
): { repeat: TaskRepeat; due: string } | null {
  let t = text.trim();
  if (!t) return null;
  // "2 weeks" / "other day" / "month on the 1st" -> "every ..."
  if (/^(?:\d+\s+|other\s+)?(?:day|week|month|year)s?\b/i.test(t)) t = `every ${t}`;
  const parsed = parseTaskInput(opts.due ? `${t} due ${opts.due}` : t, opts);
  return parsed.repeat && parsed.due ? { repeat: parsed.repeat, due: parsed.due } : null;
}

/** The fields for creating a task from parsed input (status waiting when someone is waited on). */
export function toNewTaskInput(parsed: ParsedTaskInput): NewTaskInput {
  const input: NewTaskInput = { title: parsed.title, tags: parsed.tags };
  if (parsed.due) input.due = parsed.due;
  if (parsed.start) input.start = parsed.start;
  if (parsed.repeat) input.repeat = parsed.repeat;
  if (parsed.priority) input.priority = parsed.priority;
  if (parsed.project) input.project = parsed.project;
  if (parsed.waitingOn) {
    input.waitingOn = parsed.waitingOn;
    input.status = 'waiting';
  }
  return input;
}

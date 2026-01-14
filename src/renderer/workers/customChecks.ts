import { CLICHES } from './cliches';
import { commonIssues } from './commonIssues';
import { shouldAllCapitalized, shouldCapitalize } from './shouldCapitalize';

export interface Diagnostic {
  from: number;
  to: number;
  severity: 'warning' | 'info' | 'error';
  message: string;
  source: string;
}

export interface CustomCheckSettings {
  checkCliches?: boolean;
}

export type CustomCheck = (text: string, settings?: CustomCheckSettings) => Diagnostic[];

type Locale = 'en-US' | 'en-GB';

// Letters whose names start with a vowel sound (for initialisms)
const LETTERS_THAT_START_WITH_VOWEL_SOUND = new Set([
  'A',
  'E',
  'F',
  'H',
  'I',
  'L',
  'M',
  'N',
  'O',
  'R',
  'S',
  'X'
]);

// Locale-aware silent h words; accept either locale, only warn when both agree
const SILENT_H: Record<Locale, Set<string>> = {
  'en-US': new Set([
    'hour',
    'hours',
    'hourly',
    'honor',
    'honors',
    'honorable',
    'honored',
    'honour',
    'honours',
    'honourable',
    'honesty',
    'honest',
    'heir',
    'heirs',
    'heiress',
    'heritable',
    'heredity',
    'herb',
    'heirloom'
  ]),
  'en-GB': new Set([
    'hour',
    'hours',
    'hourly',
    'honour',
    'honours',
    'honourable',
    'honest',
    'heir',
    'heirs',
    'heiress',
    'heirloom'
  ])
};

// Words that start with a vowel letter but consonant sound
const STARTS_WITH_CONSONANT_SOUND_EXCEPTIONS = [
  /^uni(?![aeiou])/i, // university, union, unit
  /^use[rd]/i, // use, user
  /^one\b/i, // one -> w sound
  /^euro/i, // euro -> y sound
  /^ub/i // ubiquitous -> y-like
];

const isSilentHWord = (normalized: string, locale: Locale): boolean => {
  if (!normalized.startsWith('h')) {
    return false;
  }
  if (SILENT_H[locale].has(normalized)) {
    return true;
  }
  for (const candidate of SILENT_H[locale]) {
    if (normalized === candidate || normalized.startsWith(candidate)) {
      return true;
    }
  }
  return false;
};

// Digits that begin with vowel sound when spoken
const DIGITS_START_WITH_VOWEL = ['8', '11', '18'];

const looksLikeInitialism = (token: string): boolean => {
  const allCaps = /^[A-Z]{2,}$/.test(token);
  const dotted = /^([A-Za-z]\.){2,}$/.test(token);
  return allCaps || dotted;
};

const digitStartsWithVowel = (token: string): boolean =>
  DIGITS_START_WITH_VOWEL.some((prefix) => token.startsWith(prefix));

const startsWithVowelLetter = (token: string): boolean => /^[aeiou]/i.test(token);

const normalizeToken = (raw: string): string =>
  String(raw)
    .trim()
    .replace(/^["'‘“]+|[’”"']+$/g, '');

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const inferArticleForLocale = (raw: string, locale: Locale): 'a' | 'an' => {
  if (!raw) {
    return 'a';
  }

  const token = normalizeToken(raw);
  const firstPart = token.split(/[-\s]/)[0];

  // Initialisms (MRI, F.B.I.)
  if (looksLikeInitialism(firstPart)) {
    const firstLetter = firstPart.replace(/\./g, '')[0]?.toUpperCase();
    return firstLetter && LETTERS_THAT_START_WITH_VOWEL_SOUND.has(firstLetter) ? 'an' : 'a';
  }

  // Numbers (8, 8-year-old)
  if (/^\d/.test(firstPart)) {
    return digitStartsWithVowel(firstPart) ? 'an' : 'a';
  }

  const normalized = firstPart.toLowerCase();

  // Silent h words
  if (normalized.startsWith('h')) {
    if (SILENT_H[locale].has(normalized)) {
      return 'an';
    }
    for (const candidate of SILENT_H[locale]) {
      if (normalized === candidate || normalized.startsWith(candidate)) {
        return 'an';
      }
    }
    // Most h-words are consonant sounded -> 'a'
    return 'a';
  }

  // Vowel letter with consonant-sound exceptions
  if (startsWithVowelLetter(normalized)) {
    for (const rx of STARTS_WITH_CONSONANT_SOUND_EXCEPTIONS) {
      if (rx.test(normalized)) {
        return 'a';
      }
    }
    return 'an';
  }

  return 'a';
};

// Only warn when both en-US and en-GB agree the article is wrong
const checkIndefiniteArticles: CustomCheck = (text: string) => {
  const diagnostics: Diagnostic[] = [];
  const articlePattern = /\b(a|an)\s+([A-Za-z0-9.-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = articlePattern.exec(text)) !== null) {
    const rawArticle = match[1].toLowerCase();
    if (rawArticle !== 'a' && rawArticle !== 'an') {
      continue;
    }
    const article = rawArticle as 'a' | 'an';
    const word = match[2];

    const normalizedFirst = normalizeToken(word).split(/[-\s]/)[0].toLowerCase();
    const hWord = normalizedFirst.startsWith('h');
    const silentUS = isSilentHWord(normalizedFirst, 'en-US');
    const silentGB = isSilentHWord(normalizedFirst, 'en-GB');

    const expectedUS = inferArticleForLocale(word, 'en-US');
    const expectedGB = inferArticleForLocale(word, 'en-GB');
    const expectedSet = new Set([expectedUS, expectedGB]);

    // Historical "an" before aspirated h; only info-level if both locales treat h as sounded
    if (hWord && article === 'an' && !silentUS && !silentGB) {
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: 'info',
        message: "Traditional 'an' before h-word; modern usage prefers 'a' in US/GB",
        source: 'Indefinite Articles'
      });
      continue;
    }

    // Accept if either locale matches the chosen article
    if (expectedSet.has(article)) {
      continue;
    }

    // Warn only when both locales agree on the opposite article
    if (expectedSet.size === 1) {
      const expected = expectedUS; // same as expectedGB here
      diagnostics.push({
        from: match.index,
        to: match.index + match[0].length,
        severity: 'warning',
        message: `Use '${expected}' here`,
        source: 'Indefinite Articles'
      });
    }
  }

  return diagnostics;
};

const checkCliches: CustomCheck = (text: string, settings?: CustomCheckSettings) => {
  const diagnostics: Diagnostic[] = [];

  if (settings?.checkCliches === false) {
    return diagnostics;
  }

  for (const phrase of CLICHES) {
    // Match case-insensitively with word boundaries on both ends where possible.
    // Many entries contain spaces/punctuation; we still try to anchor to boundaries to avoid substrings.
    const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = pattern.exec(text)) !== null) {
      diagnostics.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: 'info',
        message: 'Cliché detected; consider rephrasing',
        source: 'Clichés'
      });
    }
  }

  return diagnostics;
};

const checkCommonIssues: CustomCheck = (text: string) => {
  const diagnostics: Diagnostic[] = [];

  for (const [phrase, details] of Object.entries(commonIssues)) {
    const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'gi');
    let m: RegExpExecArray | null;

    // eslint-disable-next-line no-cond-assign
    while ((m = pattern.exec(text)) !== null) {
      const replacement =
        'replace' in details && details.replace !== undefined
          ? Array.isArray(details.replace)
            ? details.replace.join(' or ')
            : details.replace
          : undefined;

      const suggestionParts = [] as string[];
      if ('omit' in details && details.omit) {
        suggestionParts.push('Consider omitting this phrase');
      }
      if (replacement) {
        suggestionParts.push(`Try ${replacement}`);
      }

      const message =
        suggestionParts.length > 0 ? suggestionParts.join('; ') : 'Potential usage issue';

      diagnostics.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: 'warning',
        message,
        source: 'Common Issues'
      });
    }
  }

  return diagnostics;
};

const checkTimeIssues: CustomCheck = (text: string) => {
  const diagnostics: Diagnostic[] = [];

  // Pattern 1: Check for AM/PM without spaces or periods (e.g., "9:00AM", "9:00am")
  // Matches: digit(s) : digit(s) optional-space [aA][mM] or [pP][mM]
  const noSpaceOrPeriods = /\d{1,2}:\d{2}\s?[ap]m/gi;
  let m: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((m = noSpaceOrPeriods.exec(text)) !== null) {
    const matched = m[0];
    const isProper = /\d{1,2}:\d{2}\s[ap]\.m\./i.test(matched);

    // If it's not already in proper format (with space and periods)
    if (!isProper) {
      diagnostics.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: 'info',
        message: "Use proper AM/PM format: add space and periods (e.g., '9:00 a.m.')",
        source: 'Time Issues'
      });
    }
  }

  // Pattern 2: Check for AM/PM with only one period or improper casing
  // Matches: digit : digit optional-space letter-m with optional periods
  const improperFormat = /\d{1,2}:\d{2}\s?[ap]\.?m\.?/gi;

  while ((m = improperFormat.exec(text)) !== null) {
    const matched = m[0];
    // Check if it's already proper (space + periods + lowercase)
    const isProper = /\d{1,2}:\d{2}\s[ap]\.m\./i.test(matched);
    const isUpperNoSpace = /\d{1,2}:\d{2}\s?[AP]M/i.test(matched);

    if (!isProper && isUpperNoSpace) {
      diagnostics.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: 'info',
        message: "Use lowercase with periods for time: '9:00 a.m.' or '9:00 p.m.'",
        source: 'Time Issues'
      });
    }
  }

  // Pattern 3: Warn about 12 a.m. and 12 p.m. ambiguity
  const midnightNoon = /12\s?[ap]\.?m\.?/gi;

  while ((m = midnightNoon.exec(text)) !== null) {
    diagnostics.push({
      from: m.index,
      to: m.index + m[0].length,
      severity: 'info',
      message:
        "'12 a.m.' (midnight) and '12 p.m.' (noon) can be ambiguous; consider using '12:00 midnight' or '12:00 noon'",
      source: 'Time Issues'
    });
  }

  return diagnostics;
};

const checkParagraphStartWithBut: CustomCheck = (text: string) => {
  const diagnostics: Diagnostic[] = [];

  // Match "But" at the start of a paragraph (after newline or at document start)
  // Pattern: (start of string or newline) followed by optional whitespace, then "But"
  const paragraphStartBut = /(^|\n)(\s*)But\b/gm;
  let m: RegExpExecArray | null;

  while ((m = paragraphStartBut.exec(text)) !== null) {
    // Calculate the start position of "But" (skip the newline/start and whitespace)
    const butStart = m.index + m[1].length + m[2].length;
    const butEnd = butStart + 3; // "But" is 3 characters

    diagnostics.push({
      from: butStart,
      to: butEnd,
      severity: 'info',
      message:
        'Avoid starting sentences or paragraphs with "But"; consider restructuring for stronger writing.',
      source: 'Paragraph Style'
    });
  }

  return diagnostics;
};

const checkCapitalization: CustomCheck = (text: string) => {
  const diagnostics: Diagnostic[] = [];

  // Match words (sequences of letters, optionally with apostrophes for contractions)
  const wordPattern = /\b[a-z']+\b/gi;
  let m: RegExpExecArray | null;

  // eslint-disable-next-line no-cond-assign
  while ((m = wordPattern.exec(text)) !== null) {
    const word = m[0];
    const normalizedWord = word.toLowerCase();

    // Skip if it's all caps (already checked form) or very short
    if (word === word.toUpperCase() || word.length < 2) {
      continue;
    }

    // Check if it should be all caps
    if (shouldAllCapitalized(normalizedWord)) {
      const expectedForm = word.toUpperCase();
      if (word !== expectedForm) {
        diagnostics.push({
          from: m.index,
          to: m.index + word.length,
          severity: 'warning',
          message: `'${word}' should be capitalized as '${expectedForm}'`,
          source: 'Capitalization'
        });
      }
    } else if (shouldCapitalize(normalizedWord)) {
      // Check if it should start with a capital
      const expectedForm = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      if (word !== expectedForm) {
        diagnostics.push({
          from: m.index,
          to: m.index + word.length,
          severity: 'warning',
          message: `'${word}' should be capitalized as '${expectedForm}'`,
          source: 'Capitalization'
        });
      }
    }
  }

  return diagnostics;
};

const customChecks: CustomCheck[] = [
  checkIndefiniteArticles,
  checkCliches,
  checkCommonIssues,
  checkTimeIssues,
  checkParagraphStartWithBut,
  checkCapitalization
];

export const runCustomChecks = (text: string, settings?: CustomCheckSettings): Diagnostic[] =>
  customChecks.flatMap((check) => check(text, settings));

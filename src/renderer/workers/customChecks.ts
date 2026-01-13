export interface Diagnostic {
  from: number;
  to: number;
  severity: 'warning' | 'info' | 'error';
  message: string;
  source: string;
}

export type CustomCheck = (text: string) => Diagnostic[];

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

const customChecks: CustomCheck[] = [checkIndefiniteArticles];

export const runCustomChecks = (text: string): Diagnostic[] =>
  customChecks.flatMap((check) => check(text));

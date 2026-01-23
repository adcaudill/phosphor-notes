import { unified } from 'unified';
import retextEnglish from 'retext-english';
import retextStringify from 'retext-stringify';
import retextPassive from 'retext-passive';
import retextSimplify from 'retext-simplify';
import retextEquality from 'retext-equality';
import retextReadability from 'retext-readability';
import retextProfanities from 'retext-profanities';
import retextRedundantAcronyms from 'retext-redundant-acronyms';
import retextIntensify from 'retext-intensify';
import retextSyntaxUrls from 'retext-syntax-urls';
import { Diagnostic, runCustomChecks } from './customChecks';
type HarperModule = typeof import('harper.js');
type HarperLint = import('harper.js').Lint;
type HarperLinter = import('harper.js').Linter;
type HarperSuggestion = import('harper.js').Suggestion;

interface GrammarSettings {
  checkPassiveVoice: boolean;
  checkSimplification: boolean;
  checkInclusiveLanguage: boolean;
  checkReadability: boolean;
  checkProfanities: boolean;
  checkCliches: boolean;
  checkIntensify: boolean;
}

interface WorkerMessage {
  text: string;
  settings: GrammarSettings;
}

interface DiagnosticMessage {
  source?: string;
  toString(): string;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createProcessor(settings: GrammarSettings) {
  // Start with base processor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processor: any = unified().use(retextEnglish).use(retextSyntaxUrls);

  // Conditionally add all plugins based on settings
  if (settings.checkReadability) {
    processor = processor.use(retextReadability);
  }
  if (settings.checkProfanities) {
    processor = processor.use(retextProfanities({ sureness: 1 }));
  }

  // Always include these plugins
  processor = processor.use(retextRedundantAcronyms);

  if (settings.checkPassiveVoice) {
    processor = processor.use(retextPassive);
  }
  if (settings.checkSimplification) {
    processor = processor.use(retextSimplify);
  }
  if (settings.checkInclusiveLanguage) {
    // Configure retext-equality with some common ignores
    // these words are often used in non-offensive contexts or to describe specific medical conditions
    // flagging these words can result in alert fatigue, causing users to ignore important warnings
    processor = processor.use(
      retextEquality({
        ignore: [
          'easy',
          'easily',
          'add',
          'asylum',
          'aunt',
          'uncle',
          'aunts',
          'uncles',
          'basically',
          'blackhat',
          'girl',
          'boy',
          'boyfriend',
          'boyfriends',
          'girlfriend',
          'girlfriends',
          'bride',
          'groom',
          'sister',
          'brother',
          'sisters',
          'brothers',
          'clearly',
          'mother',
          'father',
          'mothers',
          'fathers',
          'mom',
          'dad',
          'moms',
          'dads',
          'daughter',
          'son',
          'daughters',
          'sons',
          'fellowship',
          'females',
          'males',
          'woman',
          'lady',
          'fellow',
          'women',
          'girls',
          'ladies',
          'man',
          'boys',
          'men',
          'gentleman',
          'gentlemen',
          'granny',
          'grandpa',
          'grandmother',
          'grandfather',
          'granddaughter',
          'grandson',
          'granddaughters',
          'grandsons',
          'grandmothers',
          'grandfathers',
          'hang',
          'bipolar',
          'depressed',
          'she',
          'he',
          'her',
          'him',
          'hers',
          'his',
          "she'd",
          "he'd",
          "she's",
          "he'll",
          "he's",
          "she's",
          'wife',
          'husband',
          'wives',
          'husbands',
          'insomnia',
          'invalid',
          'just',
          'king',
          'queen',
          'kings',
          'queens',
          'emperor',
          'empress',
          'maiden name',
          'manic',
          'maternal',
          'paternal',
          'paternity',
          'midwife',
          'niece',
          'nephew',
          'nieces',
          'nephews',
          'psychopathology',
          'mental',
          'obvious',
          'obviously',
          'ocd',
          'o.c.d.',
          'of course',
          'panic attack',
          'princess',
          'prince',
          'princesses',
          'princes',
          'psychotic',
          'schizophrenic',
          'simple',
          'simply',
          'spade',
          'stepsister',
          'stepbrother',
          'stepsisters',
          'stepbrothers',
          'straight forward',
          'straightforward',
          'straight forwardly',
          'straightforwardly',
          'superman',
          'superwoman',
          'whitehat',
          'widow',
          'widower',
          'widows',
          'widowers'
        ],
        binary: true
      })
    );
  }
  if (settings.checkIntensify) {
    processor = processor.use(retextIntensify);
  }

  return processor.use(retextStringify);
}

let harperLinterPromise: Promise<HarperLinter | null> | null = null;

const getHarperLinter = async (): Promise<HarperLinter | null> => {
  if (!harperLinterPromise) {
    harperLinterPromise = import('harper.js')
      .then(async (harper: HarperModule) => {
        const detectDialect = (): number => {
          const locale =
            (typeof navigator !== 'undefined' &&
              (navigator.languages?.[0] || navigator.language)) ||
            (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().locale) ||
            '';

          const normalized = locale.toLowerCase();

          if (normalized.includes('en-gb')) return harper.Dialect.British;
          if (normalized.includes('en-ca')) return harper.Dialect.Canadian;
          if (normalized.includes('en-au')) return harper.Dialect.Australian;
          if (normalized.includes('en-in')) return harper.Dialect.Indian;

          return harper.Dialect.American;
        };

        const linter = new harper.LocalLinter({
          // Use the inlined WASM to avoid MIME-type issues when served by dev/preview servers.
          binary: harper.binaryInlined ?? harper.binary,
          dialect: detectDialect()
        });

        await linter.setLintConfig({
          SpellCheck: false,
          DefiniteArticle: false
        });

        await linter.setup();
        return linter;
      })
      .catch((err) => {
        console.error('Failed to initialize Harper linter:', err);
        return null;
      });
  }

  return harperLinterPromise;
};

const formatHarperSuggestion = (suggestion: HarperSuggestion): string => {
  const replacement = suggestion.get_replacement_text();
  const kind = suggestion.kind();

  if (kind === 1) {
    return 'Suggestion: remove';
  }

  if (kind === 2) {
    return replacement ? `Suggestion: insert "${replacement}" after` : 'Suggestion: insert after';
  }

  return replacement ? `Suggestion: replace with "${replacement}"` : 'Suggestion: replace';
};

const runHarperDiagnostics = async (text: string): Promise<Diagnostic[]> => {
  try {
    const linter = await getHarperLinter();
    if (!linter) {
      return [];
    }

    const lints = await linter.lint(text, { language: 'markdown' });

    return lints.map((lint: HarperLint) => {
      const span = lint.span();
      const from = Math.max(0, span.start);
      let to = Math.max(from + 1, span.end);

      if (to <= from) {
        to = from + 1;
      }

      const suggestions = lint.suggestions();
      const suggestionText = suggestions[0] ? formatHarperSuggestion(suggestions[0]) : '';
      const message = suggestionText ? `${lint.message()}\n${suggestionText}` : lint.message();
      const source = lint.lint_kind_pretty ? lint.lint_kind_pretty() : 'Harper';

      return {
        from,
        to,
        severity: 'warning',
        message,
        source: source || 'Harper'
      };
    });
  } catch (err) {
    console.error('Harper lint error:', err);
    return [];
  }
};

// Helper function to calculate offset from line/column
function calculateOffset(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }

  offset += column - 1;
  return Math.max(0, offset);
}

const runRetextDiagnostics = async (
  text: string,
  settings: GrammarSettings
): Promise<Diagnostic[]> => {
  const processor = createProcessor(settings);
  const file = await processor.process(text);

  const messages: DiagnosticMessage[] = (file.messages || []).filter((m: DiagnosticMessage) => {
    const s = String(m || '');

    if (
      m &&
      m.source === 'retext-contractions' &&
      s.includes('Unexpected straight apostrophe in')
    ) {
      return false;
    }

    if (
      m &&
      m.source === 'retext-readability' &&
      s.includes('Unexpected hard to read sentence, according to')
    ) {
      const posMatch = s.match(/^(\d+):(\d+)-(\d+):(\d+):/);
      if (posMatch) {
        const startLine = parseInt(posMatch[1], 10);
        const lines = text.split('\n');
        const lineText = (lines[startLine - 1] || '').trimStart();
        if (lineText.startsWith('- ')) {
          return false;
        }
      }
    }

    return true;
  });

  return (messages || []).map((msg: DiagnosticMessage) => {
    let from = 0;
    let to = 0;

    const msgStr = String(msg);
    const posMatch = msgStr.match(/^(\d+):(\d+)-(\d+):(\d+):/);

    if (posMatch) {
      const startLine = parseInt(posMatch[1], 10);
      const startColumn = parseInt(posMatch[2], 10);
      const endLine = parseInt(posMatch[3], 10);
      const endColumn = parseInt(posMatch[4], 10);

      from = calculateOffset(text, startLine, startColumn);
      to = calculateOffset(text, endLine, endColumn);
    }

    if (to <= from) {
      to = from + 1;
    }

    const messageText = msgStr.replace(/^\d+:\d+-\d+:\d+:\s*/, '');

    let source = 'Style Guide';
    if (msg.source) {
      const sourceMap: Record<string, string> = {
        'retext-passive': 'Passive Voice',
        'retext-simplify': 'Simplification',
        'retext-equality': 'Inclusive Language',
        'retext-readability': 'Readability',
        'retext-profanities': 'Profanity',
        'retext-redundant-acronyms': 'Redundant Acronym',
        'retext-intensify': 'Weak & Weasel Words'
      };
      source = sourceMap[msg.source] || msg.source;
    }

    return {
      from,
      to,
      severity: 'warning',
      message: messageText,
      source
    };
  });
};

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { text, settings } = e.data;

  try {
    const [retextDiagnostics, harperDiagnostics] = await Promise.all([
      runRetextDiagnostics(text, settings),
      runHarperDiagnostics(text)
    ]);

    const customDiagnostics = runCustomChecks(text, { checkCliches: settings.checkCliches });
    const allDiagnostics = [...harperDiagnostics, ...retextDiagnostics, ...customDiagnostics];

    self.postMessage(allDiagnostics);
  } catch (err) {
    console.error('Grammar worker error:', err);
    self.postMessage([]);
  }
};

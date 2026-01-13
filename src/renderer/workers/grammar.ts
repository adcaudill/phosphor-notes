import { unified } from 'unified';
import retextEnglish from 'retext-english';
import retextStringify from 'retext-stringify';
import retextPassive from 'retext-passive';
import retextSimplify from 'retext-simplify';
import retextEquality from 'retext-equality';
import retextReadability from 'retext-readability';
import retextProfanities from 'retext-profanities';
import retextRedundantAcronyms from 'retext-redundant-acronyms';
import retextRepeatedWords from 'retext-repeated-words';
import { Diagnostic, runCustomChecks } from './customChecks';

interface GrammarSettings {
  checkPassiveVoice: boolean;
  checkSimplification: boolean;
  checkInclusiveLanguage: boolean;
  checkReadability: boolean;
  checkProfanities: boolean;
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
  let processor: any = unified().use(retextEnglish);

  // Conditionally add all plugins based on settings
  if (settings.checkReadability) {
    processor = processor.use(retextReadability);
  }
  if (settings.checkProfanities) {
    processor = processor.use(retextProfanities);
  }

  // Always include these plugins
  processor = processor.use(retextRedundantAcronyms).use(retextRepeatedWords);

  if (settings.checkPassiveVoice) {
    processor = processor.use(retextPassive);
  }
  if (settings.checkSimplification) {
    processor = processor.use(retextSimplify);
  }
  if (settings.checkInclusiveLanguage) {
    processor = processor.use(retextEquality);
  }

  return processor.use(retextStringify);
}

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

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { text, settings } = e.data;

  try {
    const processor = createProcessor(settings);
    const file = await processor.process(text);

    // Convert VFile messages to CodeMirror Diagnostics
    const diagnostics: Diagnostic[] = (file.messages || []).map((msg: DiagnosticMessage) => {
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
          'retext-repeated-words': 'Repeated Words'
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

    const customDiagnostics = runCustomChecks(text);
    const allDiagnostics = [...diagnostics, ...customDiagnostics];

    self.postMessage(allDiagnostics);
  } catch (err) {
    console.error('Grammar worker error:', err);
    self.postMessage([]);
  }
};

import { linter, Diagnostic } from '@codemirror/lint';
import grammarWorkerModule from '../../../workers/grammar.ts?worker';

interface GrammarSettings {
  checkPassiveVoice: boolean;
  checkSimplification: boolean;
  checkInclusiveLanguage: boolean;
  checkReadability: boolean;
  checkProfanities: boolean;
  checkCliches: boolean;
  checkIntensify: boolean;
}

export interface GrammarLint {
  extension: ReturnType<typeof linter>;
  // Terminates the backing worker. Must be called by the owner when the
  // editor view that uses this lint is torn down - the worker's lifetime
  // isn't tied to the CodeMirror view, so nothing else will release it.
  destroy: () => void;
}

export function createGrammarLint(settings: GrammarSettings): GrammarLint {
  // Create a new worker instance for this editor instance
  const grammarWorker = new grammarWorkerModule();

  const extension = linter(
    async (view) => {
      const doc = view.state.doc.toString();

      // If doc is too large, skip checking to avoid performance issues
      if (doc.length > 50000) return [];

      return new Promise<Diagnostic[]>((resolve) => {
        // Set up a one-time listener for this specific request
        const handler = (e: MessageEvent<Diagnostic[]>): void => {
          grammarWorker.removeEventListener('message', handler);
          resolve(e.data);
        };

        grammarWorker.addEventListener('message', handler);

        // Send both text and settings to the worker
        grammarWorker.postMessage({
          text: doc,
          settings
        });
      });
    },
    {
      delay: 750 // Debounce: Wait 750ms after typing stops before checking
    }
  );

  return {
    extension,
    destroy: () => grammarWorker.terminate()
  };
}

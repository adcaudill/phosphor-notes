---
layout: page
title: "Grammar & Error Checking"
parent: "Technical Notes"
---

This document describes how Phosphor Notes detects and surfaces grammar, style, and writing errors to users.

**Key files**
- Editor extension that wires linting into CodeMirror: [src/renderer/src/editor/extensions/grammar.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/src/editor/extensions/grammar.ts#L1-L120)
- Worker that runs the grammar pipeline: [src/renderer/workers/grammar.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/workers/grammar.ts#L1-L200)
- Site-specific/custom checks: [src/renderer/workers/customChecks.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/workers/customChecks.ts#L1-L200)
- Settings UI (toggles exposed to users): [src/renderer/src/components/SettingsModal.tsx](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/src/components/SettingsModal.tsx#L220-L320)

## Overview

The grammar and error-checking feature is implemented as a client-side, worker-based pipeline that combines three main sources of diagnostics:

1. A configurable set of retext-based style checks (passive voice, simplification, inclusive language, readability, profanities, redundancies, intensifiers).
2. Harper (harper.js) — an optional WASM-based linter used for additional grammar suggestions and suggestions where available.
3. A set of custom, project-specific heuristics and rules implemented in JavaScript (clichés, common usage errors, capitalization rules, time-format checks, and miscellaneous grammar heuristics).

The pieces are orchestrated inside a dedicated web worker; the editor extension simply posts the document text (and the current grammar settings) to the worker and receives an array of diagnostics back.

##Editor integration (how linting is started)

- The editor-side integration lives in [src/renderer/src/editor/extensions/grammar.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/src/editor/extensions/grammar.ts#L1-L120). The exported `createGrammarLint()` returns a CodeMirror `linter` function.
- For each editor instance a fresh worker is created (`new grammarWorkerModule()`), so each editor has an isolated worker instance.
- The linter callback reads `view.state.doc.toString()` and skips grammar checking for very large documents: a hard limit of 50,000 characters prevents running the pipeline on huge notes (early-exit). See the length guard in the extension.
- Requests are debounced: the linter uses a 750 ms delay (so checks run after 750 ms of typing inactivity).
- The extension sends a single message to the worker with `{ text, settings }` and installs a one-time `message` listener to resolve the Promise with the returned diagnostics array.

##Worker pipeline (what happens inside the worker)

The worker is the heart of the feature; it performs three categories of checks and merges their results.

1) retext pipeline (retext-*/unified plugins)
- The worker builds a `unified()` processor and conditionally registers retext plugins depending on `settings` (the toggles the user sets). This is done in `createProcessor(settings)` in [src/renderer/workers/grammar.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/workers/grammar.ts#L1-L200).
- The following plugins are used when enabled:
  - `retext-passive` (passive voice detection)
  - `retext-simplify` (suggest simpler phrasing)
  - `retext-equality` (inclusive language checks; the code configures a long `ignore` list to reduce noisy hits)
  - `retext-readability` (readability scoring and long/complex sentence detection)
  - `retext-profanities` (profane / offensive language detection)
  - `retext-intensify` (weak/hedging/intensifying words detection)
  - `retext-redundant-acronyms` and `retext-syntax-urls` are always included to catch redundancy and URL issues.
- After processing the document text the worker filters and converts retext messages into diagnostics. Messages are filtered to reduce false positives (for example, skipping some `retext-contractions` messages and ignoring some `retext-readability` hits that are list items).
- retext reports positions as line/column ranges; the worker converts these to absolute offsets using `calculateOffset(text, line, column)`.
- For each message the worker maps the `source` (retext plugin name) to a human-readable source string like "Passive Voice" or "Readability" so the editor UI shows sensible labels.

2) Harper (harper.js)
- The worker lazily imports `harper.js` at runtime (so the heavy WASM component is only pulled in if needed). The import is wrapped in a `getHarperLinter()` helper that caches a promise to avoid re-initializing the linter multiple times.
- The Harper linter is configured with some features disabled by default (for example spelling is disabled via `setLintConfig({ SpellCheck: false, DefiniteArticle: false, UseTitleCase: false })`). The linter is initialized with an appropriate dialect inferred from the runtime locale (American, British, Canadian, Australian, Indian) using `navigator`/`Intl` detection.
- Harper produces `Lint` objects that include spans and optional suggestions; these are mapped into the same diagnostic shape (absolute offsets, severity 'warning', a message and a `source` string). Suggestions are formatted (insert/replace/remove) and appended to the message text when available.
- Harper is called concurrently with retext to speed up processing.

3) Custom checks (project heuristics)
- A set of custom JavaScript checks runs synchronously on the input text (`runCustomChecks()` in [src/renderer/workers/customChecks.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/workers/customChecks.ts#L1-L200)). Each check returns an array of diagnostics; these checks include:
  - Indefinite article checks (suggesting `a` vs `an` based on locale-aware heuristics and silent-`h` handling).
  - Cliché detection (matching against a large `CLICHES` list).
  - Common usage issues (mapping known misspellings & poor phrase choices to suggested replacements).
  - Time format suggestions (AM/PM formatting guidance and ambiguity warnings for 12 a.m./12 p.m.).
  - Paragraph start checks (flagging sentences that begin with "But" at paragraph start).
  - Capitalization heuristics (suggest words that should be all-caps or initial-capitalized using `shouldAllCapitalized()` / `shouldCapitalize()`).
  - Grammar heuristics like confusing "sense"/"since" and incorrect "they're/there/their" usage.

## Merging and prioritization

- After collecting results the worker performs a merge step:
  - `customDiagnostics` are computed first.
  - `harperDiagnostics` are filtered to remove any diagnostics that exactly overlap a span produced by a custom check. This prevents duplicate or conflicting diagnostics for the exact same text range (custom checks take precedence on identical spans).
  - The final `allDiagnostics` array is `[...customDiagnostics, ...harperFiltered, ...retextDiagnostics]` and is posted back to the editor.
- The editor-side listener receives that array and resolves the linter promise; CodeMirror then displays the diagnostics as inline highlights/tooltips according to its lint UI.

## Diagnostic shape and offsets

- Diagnostics use the following minimal shape (TypeScript types are in the workers):
  - `from` (number): absolute start offset in document
  - `to` (number): absolute end offset in document
  - `severity`: `'warning' | 'info' | 'error'`
  - `message` (string)
  - `source` (string)
- Note: retext reports positions as "line:col - line:col" in message strings. The worker parses those and converts them to absolute offsets with `calculateOffset()`.
- The worker guarantees `to > from` by forcing a one-character range when the computed `to` would be <= `from`.

## Settings and user controls

- The app exposes several toggles in the Settings modal under "Grammar & Style". See the UI in [src/renderer/src/components/SettingsModal.tsx](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/src/components/SettingsModal.tsx#L220-L320).
- The settings are expressed as a `GrammarSettings` object passed from the editor extension to the worker and include booleans such as:
  - `checkPassiveVoice`
  - `checkSimplification`
  - `checkInclusiveLanguage`
  - `checkReadability`
  - `checkProfanities`
  - `checkCliches`
  - `checkIntensify`
- The worker conditionally adds or omits retext plugins based on these flags; the custom checks also observe `checkCliches` when deciding whether to run cliché detection.

## Performance and failure handling

- The editor-side check avoids running on extremely large documents by using an early length guard (50k characters).
- Each editor instance gets its own worker to keep tasks isolated and avoid cross-talk between documents.
- The worker `getHarperLinter()` caches the harper import/initialization promise so the expensive WASM setup only happens once per worker process.
- All worker exceptions are caught; on error the worker logs to console and posts an empty diagnostics array back to the editor so the UI remains responsive.

## Rules, overrides, and false-positive mitigation

- The implementation is intentionally conservative in some places to avoid alert fatigue:
  - `retext-equality` is configured with a long `ignore` list to avoid flagging many family/medical/generic terms that would otherwise cause noise.
  - The worker filters a subset of `retext` messages (examples: contractions apostrophe warnings and some `retext-readability` hits inside list bullets) to reduce irrelevant alerts.
  - Custom checks often use 'info' severity for stylistic guidance and 'warning' for stronger, likely mistakes.
  - Custom checks take precedence over Harper when they produce identical spans to avoid duplicate/conflicting messages.

## Extending or modifying checks

- To add a new retext rule, add/enable the relevant package in the worker and register it inside `createProcessor(settings)`.
- To add a new custom heuristic, add a `CustomCheck` implementation in [src/renderer/workers/customChecks.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/workers/customChecks.ts#L1-L200) and append it to the `customChecks` list. The function should accept `(text: string, settings?: CustomCheckSettings): Diagnostic[]` and return absolute offsets.
- If you need Harper to behave differently, update `getHarperLinter()` in [src/renderer/workers/grammar.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/renderer/workers/grammar.ts#L1-L200) — for example adjusting `setLintConfig()` options or dialect detection.

## Testing and debugging tips

- You can instrument the worker by adding temporary console logs; worker console messages appear in renderer devtools (the web worker's console).
- Unit tests for many checks exist in the repo under `src/main/__tests__` and similar test folders — check the repo test suite for examples of expected diagnostics.
- To reproduce locale-specific behavior (Harper dialect or article inference), set `navigator.language`/`navigator.languages` in the environment or override `detectDialect()` in `getHarperLinter()` when testing.

## Conclusion

The grammar & error checking system is a hybrid approach that combines community tooling (retext and plugins), an optional WASM-based linter (harper.js) for stronger grammar suggestions, and a set of lightweight, maintainable custom checks for app-specific heuristics. The system is designed to be configurable, to minimize false positives, and to run off the main thread to preserve editor responsiveness.

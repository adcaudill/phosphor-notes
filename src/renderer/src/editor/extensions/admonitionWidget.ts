import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const ADMONITION_TYPES = new Set<string>([
  'note',
  'tip',
  'info',
  'warning',
  'danger',
  'caution',
  'bug',
  'example',
  'quote'
]);

/**
 * Detects Obsidian-style admonitions/callouts and applies styling.
 * Syntax: > [!TYPE]
 * Where TYPE is one of: note, tip, info, warning, danger, caution, bug, example, quote
 *
 * This plugin adds CSS classes to blockquotes that match the pattern,
 * allowing CSS to handle the styling.
 */
export const admonitionWidget = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      const processedLines = new Set<number>();

      // Iterate through document lines using CodeMirror's line API
      for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
        if (processedLines.has(lineNum)) continue;

        const line = doc.line(lineNum);
        const text = line.text;

        // Check if this line starts an admonition: > [!TYPE]
        const match = text.match(/^(>\s*)(\[!(\w+)\])/i);

        if (match) {
          const type = match[3].toLowerCase();

          // Only process if it's a recognized admonition type
          if (ADMONITION_TYPES.has(type)) {
            processedLines.add(lineNum);

            // Only decorate the admonition marker itself (> [!TYPE])
            // Don't decorate the entire line to avoid conflicts with other decorators (like linting)
            const markerEnd = line.from + match[0].length;
            builder.add(
              line.from,
              markerEnd,
              Decoration.mark({
                class: `cm-admonition-marker cm-admonition-marker-${type}`,
                attributes: { 'data-admonition-type': type }
              })
            );

            // Find all following blockquote continuation lines
            let nextLineNum = lineNum + 1;
            while (nextLineNum <= doc.lines) {
              const nextLine = doc.line(nextLineNum);
              if (nextLine.text.match(/^>\s/)) {
                // For continuation lines, mark just the > marker
                const markerMatch = nextLine.text.match(/^(>\s*)/);
                if (markerMatch) {
                  const contMarkerEnd = nextLine.from + markerMatch[0].length;
                  builder.add(
                    nextLine.from,
                    contMarkerEnd,
                    Decoration.mark({
                      class: `cm-admonition-marker cm-admonition-marker-${type} cm-admonition-cont-marker`,
                      attributes: { 'data-admonition-type': type }
                    })
                  );
                }
                processedLines.add(nextLineNum);
                nextLineNum++;
              } else {
                break;
              }
            }
          }
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

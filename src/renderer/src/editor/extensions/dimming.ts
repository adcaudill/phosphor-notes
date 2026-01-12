import { Decoration, ViewPlugin, EditorView, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, RangeSet } from '@codemirror/state';

/**
 * Paragraph Dimming Plugin
 *
 * Highlights the active paragraph by dimming all other paragraphs.
 * Creates a "focus" effect where the paragraph being edited is crisp
 * and surrounding paragraphs fade into the background.
 *
 * - Active paragraph: 100% opacity (no dimming)
 * - Inactive paragraphs: 25% opacity (dimmed effect)
 */

// Define the dimmed decoration
const dimmedDeco = Decoration.line({ class: 'cm-dimmed-line' });

export const dimmingPlugin = ViewPlugin.fromClass(
  class {
    decorations;

    constructor(view: EditorView) {
      this.decorations = this.getDeco(view);
    }

    update(update: ViewUpdate): void {
      // Recalculate decorations when:
      // - The selection changed (cursor moved to different paragraph)
      // - The document changed (user typed, affecting line structure)
      // - Viewport changed (visible area changed)
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.getDeco(update.view);
      }
    }

    getDeco(view: EditorView): RangeSet<Decoration> {
      const builder = new RangeSetBuilder<Decoration>();
      const { from: selFrom, to: selTo } = view.state.selection.main;

      // Don't apply any dimming until the user moves the cursor from the initial position
      if (selFrom === 0) {
        return builder.finish();
      }

      // Find the start and end lines of the current selection/cursor position
      const cursorLine = view.state.doc.lineAt(selFrom);
      const endLine = view.state.doc.lineAt(selTo);

      // Find paragraph boundaries by looking for blank lines
      // A paragraph is a group of consecutive non-blank lines
      const startLine = this.findParagraphStart(view, cursorLine.number);
      const activeParagraphEndLine = this.findParagraphEnd(view, endLine.number);

      // Loop through all lines in the document
      let lineNum = 1;
      while (lineNum <= view.state.doc.lines) {
        // If this line is NOT part of the active paragraph, dim it
        if (lineNum < startLine || lineNum > activeParagraphEndLine) {
          const line = view.state.doc.line(lineNum);
          // Only dim non-empty lines
          if (line.text.trim()) {
            builder.add(line.from, line.from, dimmedDeco);
          }
        }
        lineNum++;
      }

      return builder.finish();
    }

    /**
     * Find the start line of the paragraph containing the given line.
     * A paragraph starts at the first non-blank line after a blank line.
     */
    public findParagraphStart(view: EditorView, lineNum: number): number {
      let current = lineNum;
      while (current > 1) {
        const prevLine = view.state.doc.line(current - 1);
        // If we hit a blank line, current is the paragraph start
        if (!prevLine.text.trim()) {
          return current;
        }
        current--;
      }
      return 1; // Beginning of document
    }

    /**
     * Find the end line of the paragraph containing the given line.
     * A paragraph ends at the last non-blank line before a blank line.
     */
    public findParagraphEnd(view: EditorView, lineNum: number): number {
      let current = lineNum;
      const totalLines = view.state.doc.lines;
      while (current < totalLines) {
        const nextLine = view.state.doc.line(current + 1);
        // If we hit a blank line, current is the paragraph end
        if (!nextLine.text.trim()) {
          return current;
        }
        current++;
      }
      return totalLines; // End of document
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

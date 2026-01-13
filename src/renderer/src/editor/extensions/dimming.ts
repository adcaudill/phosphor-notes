import { Decoration, ViewPlugin, EditorView, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, RangeSet, StateEffect } from '@codemirror/state';

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
const toggleDimmingEffect = StateEffect.define<boolean>();

export const dimmingPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    dimmingEnabled: boolean;
    view: EditorView;
    scrollHandler: (event: Event) => void;
    lastInputTs: number;

    constructor(view: EditorView) {
      this.view = view;
      this.dimmingEnabled = true;
      this.decorations = this.getDeco(view);
      this.lastInputTs = Date.now();

      // Disable dimming immediately on any manual scroll so newly revealed content stays readable
      this.scrollHandler = (event: Event) => {
        // Ignore programmatic scrolls and scrolls that occur immediately after cursor moves/typing
        if (!event.isTrusted) return;
        if (Date.now() - this.lastInputTs < 750) return;
        view.dispatch({ effects: toggleDimmingEffect.of(false) });
      };
      view.scrollDOM.addEventListener('scroll', this.scrollHandler, { passive: true });
    }

    update(update: ViewUpdate): void {
      const { docChanged, selectionSet } = update;

      // Apply explicit toggle requests (e.g., from scroll handler)
      let toggle: boolean | null = null;
      for (const tr of update.transactions) {
        for (const ef of tr.effects) {
          if (ef.is(toggleDimmingEffect)) {
            toggle = ef.value;
          }
        }
      }

      if (toggle === false) {
        this.dimmingEnabled = false;
        this.view.dom.classList.add('cm-dimming-off');
        return;
      }

      // Resume dimming when the user types or moves the cursor
      if (docChanged || selectionSet) {
        this.lastInputTs = Date.now();
        if (!this.dimmingEnabled) {
          this.dimmingEnabled = true;
          this.view.dom.classList.remove('cm-dimming-off');
        }
        this.decorations = this.getDeco(update.view);
      }

      // Recalculate decorations when user input changes the active paragraph
      // - The selection changed (cursor moved to different paragraph)
      // - The document changed (user typed, affecting line structure)
    }

    destroy(): void {
      this.view.dom.classList.remove('cm-dimming-off');
      this.view.scrollDOM.removeEventListener('scroll', this.scrollHandler);
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

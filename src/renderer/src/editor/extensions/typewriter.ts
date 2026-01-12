import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

/**
 * Typewriter Scrolling Plugin
 *
 * Keeps the cursor centered in the viewport as you type.
 * This creates the "typewriter" effect where the text scrolls up/down
 * while the cursor stays in the visual center of the screen.
 */
export const typewriterScrollPlugin = ViewPlugin.fromClass(
  class {
    constructor(public view: EditorView) {}

    update(update: ViewUpdate) {
      // Trigger centering when:
      // - The selection changed (cursor moved)
      // - The document changed (user typed)
      // - The view was resized (viewport changed)
      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        // Use requestAnimationFrame to ensure DOM has updated before measuring
        requestAnimationFrame(() => {
          const cursor = update.state.selection.main.head;

          // Get the scroller element and smooth scroll it
          const scrollerElem = this.view.scrollDOM;
          if (scrollerElem) {
            // Dispatch scrollIntoView effect with smooth behavior option
            this.view.dispatch({
              effects: EditorView.scrollIntoView(cursor, { y: 'center' })
            });
            // Apply smooth behavior CSS if not already set
            if (scrollerElem.style.scrollBehavior !== 'smooth') {
              scrollerElem.style.scrollBehavior = 'smooth';
            }
          }
        });
      }
    }
  }
);

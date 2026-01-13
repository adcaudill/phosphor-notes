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
    public isPointerDown = false;
    public hasDragged = false;

    constructor(public view: EditorView) {}

    public centerCursorSmooth(): void {
      const cursor = this.view.state.selection.main.head;
      const scroller = this.view.scrollDOM;
      if (!scroller) return;

      const coords = this.view.coordsAtPos(cursor);
      if (!coords) return;

      const scrollerRect = scroller.getBoundingClientRect();
      const cursorMid = (coords.top + coords.bottom) / 2;
      const cursorOffset = cursorMid - scrollerRect.top;
      const viewportCenter = scroller.clientHeight / 2;
      const centerOffset = cursorOffset - viewportCenter;

      const deadZone = scroller.clientHeight * 0.1;
      if (Math.abs(centerOffset) <= deadZone) return;

      const targetTop = scroller.scrollTop + centerOffset;
      scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
    }

    update(update: ViewUpdate): void {
      // Skip typewriter scrolling while the user is actively dragging a selection.
      if (this.isPointerDown) return;

      // Only recenter when the cursor or document moves. Avoid reacting to scroll-only viewport changes
      // so users can freely scroll long documents without being pulled back to the cursor.
      const shouldCenter = update.selectionSet || update.docChanged;
      if (!shouldCenter) return;

      // Use requestAnimationFrame to ensure DOM has updated before measuring
      requestAnimationFrame(() => {
        if (this.isPointerDown) return;
        this.centerCursorSmooth();
      });
    }
  },
  {
    eventHandlers: {
      pointerdown(event) {
        if (event.button === 0) {
          this.isPointerDown = true;
          this.hasDragged = false;
        }
      },
      pointermove() {
        if (this.isPointerDown) {
          this.hasDragged = true;
        }
      },
      pointerup(event) {
        if (event.button === 0) {
          this.isPointerDown = false;
          // If this was a simple click (no drag), re-center the cursor now.
          if (!this.hasDragged) {
            this.centerCursorSmooth();
          }
          this.hasDragged = false;
        }
      },
      pointercancel() {
        this.isPointerDown = false;
        this.hasDragged = false;
      },
      blur() {
        this.isPointerDown = false;
        this.hasDragged = false;
      }
    }
  }
);

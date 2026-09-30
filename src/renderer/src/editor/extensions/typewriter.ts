import { EditorState, Extension, StateEffect, StateEffectType } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

// CodeMirror doesn't export the scroll-into-view effect type, so grab it from a probe effect.
const scrollIntoViewEffect = (
  EditorView.scrollIntoView(0) as unknown as { type: StateEffectType<unknown> }
).type;

const hasExplicitScroll = (effects: readonly StateEffect<unknown>[]): boolean =>
  effects.some((effect) => effect.is(scrollIntoViewEffect));

/** Marks a transaction whose cursor should be smoothly scrolled to the vertical center. */
export const typewriterCenterRequest = StateEffect.define<null>();

// Ignore moves smaller than this so sub-pixel layout noise doesn't start an animation.
const MIN_SCROLL_DELTA = 2;

/** Scroll duration grows with distance: a one-line nudge is quick, a long jump is gentler. */
export const scrollDuration = (distance: number): number =>
  Math.min(400, Math.max(150, 120 + Math.abs(distance) * 0.3));

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * The scrollTop that puts a line spanning [lineTop, lineBottom] (viewport coordinates) in the
 * middle of the scroller, clamped to the scrollable range.
 */
export const centeredScrollTop = (m: {
  lineTop: number;
  lineBottom: number;
  scrollerTop: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): number => {
  const lineMid = (m.lineTop + m.lineBottom) / 2 - m.scrollerTop;
  const target = m.scrollTop + lineMid - m.clientHeight / 2;
  return Math.max(0, Math.min(m.scrollHeight - m.clientHeight, target));
};

/**
 * Decides *when* to center: any transaction that already asks CodeMirror to reveal the cursor
 * (typing, Enter, arrow keys, undo, etc.). Transactions that don't ask to scroll are left alone,
 * which notably includes mouse selections, so clicking or double-clicking never moves the text
 * out from under the pointer, and scrolling away to read doesn't snap back until you type or
 * move the cursor from the keyboard.
 */
const centerRequester = EditorState.transactionExtender.of((tr) => {
  if (!tr.scrollIntoView) return null;
  // Pointer selections never set scrollIntoView today; guard anyway so a click can't recenter.
  if (tr.isUserEvent('select.pointer')) return null;
  // Respect a caller that already chose where to scroll (search, scrollToLine, etc.).
  if (hasExplicitScroll(tr.effects)) return null;
  return { effects: typewriterCenterRequest.of(null) };
});

/**
 * Performs the centering as a short eased scroll so the eye can follow the text.
 *
 * CodeMirror's own "nearest" reveal still runs first; while the cursor is on screen that's a
 * no-op, and if it was off screen it just brings it to the edge before we glide it to center.
 * Measurement goes through requestMeasure so it happens in CodeMirror's layout cycle. A new
 * request mid-animation retargets from wherever the scroll currently is, and any user scroll
 * (wheel, touch, scrollbar, click) cancels the animation immediately.
 */
const centerAnimator = ViewPlugin.fromClass(
  class {
    private frame: number | null = null;
    private target: number | null = null;
    private readonly cancel = (): void => this.stop();

    constructor(private readonly view: EditorView) {
      const scroller = view.scrollDOM;
      scroller.addEventListener('wheel', this.cancel, { passive: true });
      scroller.addEventListener('touchstart', this.cancel, { passive: true });
      scroller.addEventListener('pointerdown', this.cancel);
    }

    update(update: ViewUpdate): void {
      const requested = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(typewriterCenterRequest))
      );
      if (!requested) return;

      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const coords = view.coordsAtPos(view.state.selection.main.head);
          if (!coords) return null;
          const scroller = view.scrollDOM;
          return centeredScrollTop({
            lineTop: coords.top,
            lineBottom: coords.bottom,
            scrollerTop: scroller.getBoundingClientRect().top,
            scrollTop: scroller.scrollTop,
            clientHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight
          });
        },
        write: (target) => {
          if (target !== null) this.scrollTo(target);
        }
      });
    }

    private scrollTo(target: number): void {
      const scroller = this.view.scrollDOM;
      // Already heading there (e.g. typing along the same line): let the current animation run.
      if (this.target !== null && Math.abs(this.target - target) < MIN_SCROLL_DELTA) return;
      this.stop();

      let from = scroller.scrollTop;
      let to = target;
      if (Math.abs(to - from) < MIN_SCROLL_DELTA) return;

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        scroller.scrollTop = to;
        return;
      }

      const duration = scrollDuration(to - from);
      const start = performance.now();
      let lastSet = from;
      this.target = to;

      const step = (now: number): void => {
        // If something else moved the scroller (e.g. CodeMirror compensating for a height
        // change above the viewport), shift the animation by the same amount instead of
        // yanking it back.
        const drift = scroller.scrollTop - lastSet;
        if (Math.abs(drift) > 1) {
          from += drift;
          to += drift;
          this.target = to;
        }

        const t = Math.min(1, (now - start) / duration);
        lastSet = from + (to - from) * easeOutCubic(t);
        scroller.scrollTop = lastSet;
        // Browsers round scrollTop; track what actually stuck so rounding isn't mistaken for drift.
        lastSet = scroller.scrollTop;

        if (t < 1) {
          this.frame = requestAnimationFrame(step);
        } else {
          this.frame = null;
          this.target = null;
        }
      };
      this.frame = requestAnimationFrame(step);
    }

    private stop(): void {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.target = null;
    }

    destroy(): void {
      this.stop();
      const scroller = this.view.scrollDOM;
      scroller.removeEventListener('wheel', this.cancel);
      scroller.removeEventListener('touchstart', this.cancel);
      scroller.removeEventListener('pointerdown', this.cancel);
    }
  }
);

/**
 * Typewriter Scrolling
 *
 * Keeps the cursor vertically centered while writing, gliding the text into place rather than
 * jumping so it's easy to keep your place.
 */
export const typewriterScroll: Extension = [centerRequester, centerAnimator];

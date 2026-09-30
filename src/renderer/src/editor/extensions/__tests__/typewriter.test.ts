import { describe, expect, it } from 'vitest';
import {
  EditorSelection,
  EditorState,
  StateEffectType,
  Transaction,
  TransactionSpec
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  centeredScrollTop,
  scrollDuration,
  typewriterCenterRequest,
  typewriterScroll
} from '../typewriter';

const scrollType = (EditorView.scrollIntoView(0) as unknown as { type: StateEffectType<unknown> })
  .type;

const run = (spec: TransactionSpec): Transaction =>
  EditorState.create({ doc: 'one\ntwo\nthree', extensions: [typewriterScroll] }).update(spec);

const requestsCenter = (tr: Transaction): boolean =>
  tr.effects.some((e) => e.is(typewriterCenterRequest));

describe('typewriterScroll', () => {
  it('requests centering when a transaction asks to reveal the cursor', () => {
    const tr = run({
      changes: { from: 13, insert: '!' },
      selection: { anchor: 14 },
      scrollIntoView: true,
      userEvent: 'input.type'
    });
    expect(requestsCenter(tr)).toBe(true);
  });

  it('does nothing for pointer selections (click / double-click)', () => {
    const tr = run({ selection: EditorSelection.range(4, 7), userEvent: 'select.pointer' });
    expect(requestsCenter(tr)).toBe(false);
  });

  it('does nothing for pointer selections even if they request scrolling', () => {
    const tr = run({ selection: { anchor: 4 }, scrollIntoView: true, userEvent: 'select.pointer' });
    expect(requestsCenter(tr)).toBe(false);
  });

  it('does nothing for changes that do not ask to scroll', () => {
    const tr = run({ changes: { from: 0, insert: 'x' } });
    expect(requestsCenter(tr)).toBe(false);
  });

  it('leaves an explicit scroll request from the caller alone', () => {
    const tr = run({
      selection: { anchor: 4 },
      scrollIntoView: true,
      effects: EditorView.scrollIntoView(0, { y: 'start' })
    });
    expect(requestsCenter(tr)).toBe(false);
    expect(tr.effects.filter((e) => e.is(scrollType))).toHaveLength(1);
  });
});

describe('centeredScrollTop', () => {
  const base = { scrollerTop: 100, scrollTop: 500, clientHeight: 600, scrollHeight: 5000 };

  it('scrolls so the cursor line sits in the middle of the scroller', () => {
    // Line midpoint is 600px into the scroller; center is at 300px, so scroll 300px further.
    expect(centeredScrollTop({ ...base, lineTop: 690, lineBottom: 710 })).toBe(800);
  });

  it('clamps to the top of the document', () => {
    expect(centeredScrollTop({ ...base, scrollTop: 0, lineTop: 110, lineBottom: 130 })).toBe(0);
  });

  it('clamps to the bottom of the document', () => {
    expect(centeredScrollTop({ ...base, scrollTop: 4400, lineTop: 690, lineBottom: 710 })).toBe(
      4400
    );
  });
});

describe('scrollDuration', () => {
  it('keeps short moves quick and caps long ones', () => {
    expect(scrollDuration(26)).toBe(150);
    expect(scrollDuration(-26)).toBe(150);
    expect(scrollDuration(5000)).toBe(400);
  });
});

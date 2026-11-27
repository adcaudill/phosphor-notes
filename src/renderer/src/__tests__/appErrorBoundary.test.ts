// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppErrorBoundary } from '../components/AppErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Exploding(): never {
  throw new Error('render exploded');
}

describe('AppErrorBoundary', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
  });

  it('renders its children when nothing goes wrong', () => {
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(createElement(AppErrorBoundary, null, createElement('p', null, 'ok'))));
    expect(container.textContent).toBe('ok');
  });

  it('shows a recovery screen instead of a blank window when rendering throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(createElement(AppErrorBoundary, null, createElement(Exploding))));

    expect(container.textContent).toContain('Something went wrong');
    expect(container.textContent).toContain('render exploded');
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Reload',
      'Copy details'
    ]);
  });
});

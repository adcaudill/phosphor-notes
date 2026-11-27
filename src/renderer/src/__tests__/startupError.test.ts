// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCRIPT = fs.readFileSync(path.resolve(__dirname, '../../public/startup-error.js'), 'utf-8');

/** Runs public/startup-error.js as the browser would: a classic script in the page's global scope. */
function loadStartupScript(): void {
  new Function(SCRIPT)();
}

const screen = (): Element | null => document.querySelector('.startup-error');
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fireUncaughtError(message: string): void {
  window.dispatchEvent(new ErrorEvent('error', { error: new Error(message), message }));
}

describe('startup error screen', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('stays out of the way once the app has rendered, and replaces a blank window otherwise', async () => {
    loadStartupScript();

    // The app is up: an uncaught error must not replace it.
    document.getElementById('root')!.appendChild(document.createElement('main'));
    fireUncaughtError('some later error');
    expect(screen()).toBeNull();

    // Nothing rendered (the React version mismatch case): show what happened.
    document.getElementById('root')!.innerHTML = '';
    fireUncaughtError(
      'Incompatible React versions: The "react" and "react-dom" packages must have the exact same version.'
    );
    const shown = screen();
    expect(shown).not.toBeNull();
    expect(shown!.textContent).toContain("Phosphor Notes couldn't start");
    expect(shown!.textContent).toContain('Incompatible React versions');
    expect(shown!.textContent).toContain('npm install');
    expect(shown!.querySelector('button')!.textContent).toBe('Reload');

    // If the app renders after all, the screen removes itself.
    document.getElementById('root')!.appendChild(document.createElement('main'));
    await tick();
    expect(screen()).toBeNull();
  });

  it('reports a script that failed to load', () => {
    loadStartupScript();
    const script = document.createElement('script');
    script.src = 'http://localhost/assets/index.js';
    document.body.appendChild(script);
    // Load errors fire on the element and don't bubble; the handler sees them in the capture phase.
    script.dispatchEvent(new Event('error'));
    expect(screen()?.textContent).toContain('A required script failed to load');
  });

  it('shows unhandled promise rejections during startup', () => {
    loadStartupScript();
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = new Error('boom at startup');
    window.dispatchEvent(event);
    expect(screen()?.textContent).toContain('boom at startup');
  });
});

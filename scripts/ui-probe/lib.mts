/**
 * UI probe: launch Phosphor Notes hidden, against a throwaway profile and a
 * fixture vault, and drive/inspect it over the Chrome DevTools Protocol -
 * screenshots at any device scale, the editor's line geometry and styles,
 * and simulated input. Built for debugging editor layout (tasks, wrapping,
 * nesting guides) without anyone copying things out of DevTools by hand.
 *
 * Nothing here touches the user's real profile or vault: every run gets a
 * fresh temporary --user-data-dir (so it also never collides with a running
 * copy of the app) and a vault built from the fixture files you pass.
 *
 * Runs directly with Node 24 (type stripping); no dependencies beyond the
 * app's own Electron. Requires a build in out/ (see `buildApp`).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProbeOptions {
  /** Repository root (where out/ and node_modules/ live). */
  repo: string;
  /** Markdown for the note the app opens (it becomes today's daily note). */
  note: string;
  /** Extra notes to put in the vault, by vault-relative path. */
  otherNotes?: Record<string, string>;
  /** Settings merged over stable probe defaults (theme, font size, ...). */
  settings?: Record<string, unknown>;
  /** Viewport size in CSS pixels. Default 1000x700. */
  width?: number;
  height?: number;
  /** Device scale factor (2 = Retina). Default 2. */
  scale?: number;
  /** Keep the temporary profile and vault after close (for inspection). */
  keepTemp?: boolean;
}

export interface LineReport {
  /** 1-based index among rendered lines (top to bottom). */
  index: number;
  /** Line text with widgets shown as [widget:class]. */
  text: string;
  classes: string;
  /** Box relative to the editor content's left edge, in CSS px. */
  left: number;
  top: number;
  width: number;
  height: number;
  paddingLeft: number;
  textIndent: number;
  /** Nesting guide columns (in ch) from the line's inline background, if any. */
  guideColumns: number[];
  /** x where each visual (wrapped) row's first character starts, relative to the content edge. */
  rowStarts: number[];
  widgets: Array<{ cls: string; left: number; top: number; width: number; height: number }>;
}

export interface EditorReport {
  /** Width of one `ch` in the editor font, in CSS px. */
  chPx: number;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  contentLeft: number;
  scale: number;
  lines: LineReport[];
}

export interface Probe {
  /** Evaluate a JS expression in the renderer and return its (JSON-able) value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Save a PNG of the editor (default) or the whole window. Returns the file path. */
  screenshot(file: string, target?: 'editor' | 'window'): Promise<string>;
  /** Measure every rendered editor line. */
  editorReport(): Promise<EditorReport>;
  /** Click at viewport coordinates, or at the center of the first element matching a selector. */
  click(target: { x: number; y: number } | string): Promise<void>;
  /** Insert text at the cursor, as typing would. */
  type(text: string): Promise<void>;
  /** Press a key, e.g. "Enter", "Tab", "Backspace", "ArrowDown", optionally with modifiers. */
  press(key: string, modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>): Promise<void>;
  /** Change the viewport size and/or device scale. */
  setViewport(width: number, height: number, scale?: number): Promise<void>;
  /** Wait for the editor to settle after input. */
  settle(ms?: number): Promise<void>;
  /** The app's console output so far. */
  log(): string;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Builds the app into out/ (electron-vite only - no typecheck), as the probe runs the built app. */
export function buildApp(repo: string): void {
  execFileSync(path.join(repo, 'node_modules', '.bin', 'electron-vite'), ['build'], {
    cwd: repo,
    stdio: 'inherit'
  });
}

function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PROBE_SETTINGS: Record<string, unknown> = {
  theme: 'dark',
  editorFontSize: 16,
  enableTypewriterScrolling: false,
  enableParagraphDimming: false,
  windowBounds: { width: 1200, height: 800 }
};

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 }
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

/** Runs in the renderer: measures every rendered .cm-line. Kept as a string so it needs no bundling. */
const REPORT_SCRIPT = `(() => {
  const content = document.querySelector('.cm-content');
  if (!content) return null;
  const contentLeft = content.getBoundingClientRect().left;
  const probe = document.createElement('span');
  probe.textContent = '0';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  content.appendChild(probe);
  const chPx = probe.getBoundingClientRect().width;
  probe.remove();
  const cs = getComputedStyle(content);
  const round = (n) => Math.round(n * 10) / 10;

  const lines = [...content.querySelectorAll('.cm-line')].map((el, i) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[contenteditable=false]').forEach((w) => {
      w.replaceWith('[widget:' + (w.className || w.tagName.toLowerCase()) + ']');
    });
    clone.querySelectorAll('img.cm-widgetBuffer').forEach((b) => b.remove());

    // Where each visual row starts: the first non-whitespace character on each row.
    const rows = new Map();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest('[contenteditable=false]')) continue;
      const text = node.textContent || '';
      for (let k = 0; k < text.length; k++) {
        if (/\\s/.test(text[k])) continue;
        const r = document.createRange();
        r.setStart(node, k);
        r.setEnd(node, k + 1);
        const rect = r.getClientRects()[0];
        if (!rect) continue;
        const rowKey = Math.round(rect.top);
        if (!rows.has(rowKey) || rect.left < rows.get(rowKey)) rows.set(rowKey, rect.left);
      }
    }
    const rowStarts = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => round(x - contentLeft));

    const guideColumns = [...(el.style.background || '').matchAll(/var\\(--editor-nesting-guide\\) (?:calc\\()?([\\d.]+)ch/g)]
      .map((m) => Number(m[1]))
      .filter((v, k, all) => all.indexOf(v) === k);

    return {
      index: i + 1,
      text: clone.textContent,
      classes: el.className,
      left: round(box.left - contentLeft),
      top: round(box.top),
      width: round(box.width),
      height: round(box.height),
      paddingLeft: round(parseFloat(style.paddingLeft)),
      textIndent: round(parseFloat(style.textIndent)),
      guideColumns,
      rowStarts,
      widgets: [...el.querySelectorAll('[contenteditable=false]')].map((w) => {
        const b = w.getBoundingClientRect();
        return {
          cls: w.className || w.tagName.toLowerCase(),
          left: round(b.left - contentLeft),
          top: round(b.top),
          width: round(b.width),
          height: round(b.height)
        };
      })
    };
  });

  return {
    chPx: round(chPx),
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    contentLeft: round(contentLeft),
    lines
  };
})()`;

export async function launchProbe(opts: ProbeOptions): Promise<Probe> {
  const mainJs = path.join(opts.repo, 'out', 'main', 'index.js');
  if (!fs.existsSync(mainJs)) {
    throw new Error(`No build at ${mainJs} - run the probe with --build (or buildApp()) first.`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-ui-probe-'));
  const profile = path.join(temp, 'profile');
  const vault = path.join(temp, 'vault');
  fs.mkdirSync(path.join(profile, '.phosphor'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });

  fs.writeFileSync(path.join(vault, `${localDate(new Date())}.md`), opts.note);
  for (const [rel, text] of Object.entries(opts.otherNotes ?? {})) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  fs.writeFileSync(
    path.join(profile, '.phosphor', 'config.json'),
    JSON.stringify({ lastVault: vault })
  );
  fs.writeFileSync(
    path.join(profile, '.phosphor', 'settings.json'),
    JSON.stringify({ ...PROBE_SETTINGS, ...opts.settings })
  );

  let appLog = '';
  const child: ChildProcess = spawn(
    path.join(opts.repo, 'node_modules', '.bin', 'electron'),
    [mainJs, `--user-data-dir=${profile}`, '--remote-debugging-port=0'],
    { env: { ...process.env, PHOSPHOR_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout?.on('data', (d) => (appLog += d));
  child.stderr?.on('data', (d) => (appLog += d));

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    // Wait for Electron to exit before deleting its profile: it keeps writing
    // there while shutting down (deleting early fails with ENOTEMPTY).
    await Promise.race([exited, sleep(5000)]);
    if (!opts.keepTemp) {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };

  try {
    // Electron writes the port it picked for --remote-debugging-port=0 here.
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) {
      if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (!port) await sleep(250);
    }
    if (!port) throw new Error('The app did not open a DevTools port.\n' + appLog.slice(-2000));

    let wsUrl = '';
    for (let i = 0; i < 80 && !wsUrl; i++) {
      try {
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as Array<{
          type: string;
          webSocketDebuggerUrl: string;
        }>;
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
      } catch {
        // not up yet
      }
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('No renderer page to attach to.\n' + appLog.slice(-2000));

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools connection failed')), {
        once: true
      });
    });
    let nextId = 0;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!waiter) return;
      pending.delete(msg.id!);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    const send = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async <T,>(expression: string): Promise<T> => {
      const res = await send<{
        result: { value?: T };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ??
            res.exceptionDetails.text ??
            'evaluate failed'
        );
      }
      return res.result.value as T;
    };

    let scale = opts.scale ?? 2;
    const setViewport = async (width: number, height: number, newScale = scale): Promise<void> => {
      scale = newScale;
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: newScale,
        mobile: false
      });
      await sleep(300);
    };

    // Wait for the editor to show the note.
    for (let i = 0; i < 80; i++) {
      if (await evaluate<boolean>(`document.querySelectorAll('.cm-content .cm-line').length > 0`)) {
        break;
      }
      await sleep(250);
    }
    await setViewport(opts.width ?? 1000, opts.height ?? 700, scale);
    await sleep(500);

    const probe: Probe = {
      evaluate,
      setViewport,
      settle: (ms = 300) => sleep(ms),
      log: () => appLog,

      async screenshot(file, target = 'editor') {
        let clip: Record<string, number> | undefined;
        if (target === 'editor') {
          const rect = await evaluate<{
            x: number;
            y: number;
            width: number;
            height: number;
          } | null>(
            `(() => { const r = document.querySelector('.cm-editor')?.getBoundingClientRect();
                      return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`
          );
          if (rect) clip = { ...rect, scale: 1 };
        }
        const shot = await send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          ...(clip ? { clip } : {})
        });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return file;
      },

      async editorReport() {
        const report = await evaluate<Omit<EditorReport, 'scale'> | null>(REPORT_SCRIPT);
        if (!report) throw new Error('No editor on screen');
        return { ...report, scale };
      },

      async click(target) {
        let point = target as { x: number; y: number };
        if (typeof target === 'string') {
          const found = await evaluate<{ x: number; y: number } | null>(
            `(() => { const r = document.querySelector(${JSON.stringify(target)})?.getBoundingClientRect();
                      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`
          );
          if (!found) throw new Error(`No element matches ${target}`);
          point = found;
        }
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: point.x,
            y: point.y,
            button: 'left',
            clickCount: 1
          });
        }
      },

      async type(text) {
        await send('Input.insertText', { text });
      },

      async press(key, modifiers = []) {
        const info = KEYS[key] ?? {
          code: `Key${key.toUpperCase()}`,
          keyCode: key.toUpperCase().charCodeAt(0)
        };
        const bits = modifiers.reduce((sum, m) => sum | MODIFIER_BITS[m], 0);
        const base = {
          key,
          code: info.code,
          windowsVirtualKeyCode: info.keyCode,
          modifiers: bits
        };
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          ...base,
          ...(info.text && bits === 0 ? { text: info.text } : {})
        });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      },

      async close() {
        try {
          ws.close();
        } finally {
          await cleanup();
        }
      }
    };
    return probe;
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** A compact, line-per-row text rendering of a report - quick to read in a terminal or a chat. */
export function formatReport(report: EditorReport): string {
  const out = [
    `font ${report.fontSize} ${report.fontFamily} | ch=${report.chPx}px | line-height ${report.lineHeight} | scale ${report.scale}x`,
    'line | left pad indent | rows start at (px from content edge) | guides (ch) | widgets | text'
  ];
  for (const l of report.lines) {
    const widgets = l.widgets.map((w) => `${w.cls.split(' ')[0]}@${w.left}+${w.width}`).join(' ');
    out.push(
      [
        String(l.index).padStart(4),
        `${l.left} ${l.paddingLeft} ${l.textIndent}`.padEnd(14),
        `[${l.rowStarts.join(', ')}]`.padEnd(22),
        `[${l.guideColumns.join(',')}]`.padEnd(10),
        widgets.padEnd(30),
        JSON.stringify(l.text)
      ].join(' | ')
    );
  }
  return out.join('\n');
}

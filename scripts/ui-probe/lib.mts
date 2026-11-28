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
  /** y of each visual row's text baseline (viewport px). */
  rowBaselines: number[];
  widgets: WidgetReport[];
  /** Human-readable collisions: widget vs text, widget vs widget, widget outside its line box. */
  overlaps: string[];
}

export interface WidgetReport {
  kind: 'checkbox' | 'pill' | 'widget';
  cls: string;
  /** Text inside the widget (pill label, or the icon's ligature name). */
  label: string;
  /** Element box: x relative to the content edge, y in viewport px. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  /** Baseline, cap-height middle, and x-height middle of the text row the widget sits on. */
  rowBaseline: number | null;
  rowCapMiddle: number | null;
  rowXMiddle: number | null;
  /**
   * The painted pixels' bounding box (same coordinates as the element box),
   * measured from a screenshot - for an icon, the drawing itself, not its
   * font box.
   */
  ink?: { left: number; right: number; top: number; bottom: number } | null;
  /**
   * Ink center minus the row's cap-height middle, in px: negative = drawn
   * higher than the capital letters' middle, positive = lower.
   */
  inkOffsetFromCapMiddle?: number | null;
}

export interface EditorReport {
  /** One character column in the body font: the "0" advance plus letter-spacing, in CSS px. */
  chPx: number;
  /** Body font cap height and x-height, in CSS px. */
  capHeight: number;
  xHeight: number;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  contentLeft: number;
  /** px of the editor past the window's right edge (0 when it fits). */
  editorOverflow: number;
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
  /** Click at the end of the nth rendered editor line (1-based), putting the cursor there. */
  placeCursorOnLine(index: number): Promise<void>;
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
  lineHeight: 1.5,
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

/**
 * Runs in the renderer: measures every rendered .cm-line. Kept as a string so
 * it needs no bundling. All x values are CSS px from the content's left edge;
 * y values are viewport CSS px.
 */
const REPORT_SCRIPT = `(() => {
  const content = document.querySelector('.cm-content');
  if (!content) return null;
  // x origin: the left edge of the line boxes, i.e. source column 0 when a line has no padding.
  const contentLeft = (content.querySelector('.cm-line') || content).getBoundingClientRect().left;
  const round = (n) => Math.round(n * 10) / 10;
  const firstLine = content.querySelector('.cm-line');
  const lineStyle = getComputedStyle(firstLine || content);

  // Font metrics per font string (headings use a different size than body text).
  const canvas = document.createElement('canvas').getContext('2d');
  const metricsCache = new Map();
  const metricsFor = (el) => {
    const s = getComputedStyle(el);
    const font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    if (!metricsCache.has(font)) {
      canvas.font = font;
      const H = canvas.measureText('H');
      metricsCache.set(font, {
        ascent: H.fontBoundingBoxAscent,
        descent: H.fontBoundingBoxDescent,
        capHeight: H.actualBoundingBoxAscent,
        xHeight: canvas.measureText('x').actualBoundingBoxAscent,
        ch: canvas.measureText('0').width
      });
    }
    return metricsCache.get(font);
  };
  const body = metricsFor(firstLine || content);

  const lines = [...content.querySelectorAll('.cm-line')].map((el, i) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[contenteditable=false]').forEach((w) => {
      w.replaceWith('[widget:' + (w.className || w.tagName.toLowerCase()) + ']');
    });
    clone.querySelectorAll('img.cm-widgetBuffer').forEach((b) => b.remove());

    // Visual rows from the text's own character boxes (widgets excluded):
    // where each row starts, its baseline, and the text segments on it.
    const rows = new Map();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[contenteditable=false]')) continue;
      const m = metricsFor(parent);
      const text = node.textContent || '';
      for (let k = 0; k < text.length; k++) {
        if (/\\s/.test(text[k])) continue;
        const r = document.createRange();
        r.setStart(node, k);
        r.setEnd(node, k + 1);
        const rect = r.getClientRects()[0];
        if (!rect) continue;
        const key = Math.round(rect.top + rect.height / 2);
        const baseline = rect.top + (rect.height - (m.ascent + m.descent)) / 2 + m.ascent;
        let row = [...rows.values()].find((v) => Math.abs(v.mid - key) < 4);
        if (!row) {
          row = { mid: key, start: Infinity, baseline, capHeight: m.capHeight, xHeight: m.xHeight, segs: [] };
          rows.set(key, row);
        }
        if (rect.left < row.start) {
          row.start = rect.left;
          row.baseline = baseline;
          row.capHeight = m.capHeight;
          row.xHeight = m.xHeight;
        }
        const last = row.segs[row.segs.length - 1];
        if (last && rect.left - last.right < m.ch * 0.6 && rect.left >= last.left) {
          last.right = Math.max(last.right, rect.right);
          last.top = Math.min(last.top, rect.top);
          last.bottom = Math.max(last.bottom, rect.bottom);
        } else {
          row.segs.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
      }
    }
    const rowList = [...rows.values()].sort((a, b) => a.mid - b.mid);

    const widgets = [...el.querySelectorAll('[contenteditable=false]')].map((w) => {
      const b = w.getBoundingClientRect();
      const cls = w.className || w.tagName.toLowerCase();
      const kind = /cm-task-checkbox/.test(cls) ? 'checkbox' : /cm-task-pill/.test(cls) ? 'pill' : 'widget';
      // The row this widget sits on: the one whose middle is closest to the widget's middle.
      const mid = b.top + b.height / 2;
      const lh = parseFloat(style.lineHeight) || box.height;
      let row = rowList.reduce((best, r) => (!best || Math.abs(r.mid - mid) < Math.abs(best.mid - mid) ? r : best), null);
      // A row with only widgets on it (e.g. a pill wrapped onto its own row)
      // has no text to measure: derive it from the first row, a line-height per row.
      if (row && Math.abs(row.mid - mid) > lh / 2) {
        const k = Math.round((mid - rowList[0].mid) / lh);
        row = { ...rowList[0], baseline: rowList[0].baseline + k * lh };
      }
      return {
        kind,
        cls,
        label: ((w.querySelector('.cm-task-pill-label') || w).textContent || '').trim().slice(0, 40),
        left: round(b.left - contentLeft),
        right: round(b.right - contentLeft),
        top: round(b.top),
        bottom: round(b.bottom),
        width: round(b.width),
        height: round(b.height),
        // The row's baseline, for judging vertical alignment.
        rowBaseline: row ? round(row.baseline) : null,
        rowCapMiddle: row ? round(row.baseline - row.capHeight / 2) : null,
        rowXMiddle: row ? round(row.baseline - row.xHeight / 2) : null,
        // Box of the glyph's own element (pills: the pill box; checkbox: the icon).
        _raw: { x: b.left, y: b.top, w: b.width, h: b.height }
      };
    });

    // Overlaps: widget vs text on the same row, widget vs widget, and
    // widgets sticking out of their line's box.
    const overlaps = [];
    const hit = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    widgets.forEach((w, wi) => {
      const abs = { left: w._raw.x, right: w._raw.x + w._raw.w, top: w._raw.y, bottom: w._raw.y + w._raw.h };
      for (const r of rowList) for (const s of r.segs) {
        if (hit(abs, s)) overlaps.push(w.kind + ' "' + w.label + '" overlaps text at x=' + round(s.left - contentLeft) + '..' + round(s.right - contentLeft));
      }
      widgets.slice(wi + 1).forEach((o) => {
        const ob = { left: o._raw.x, right: o._raw.x + o._raw.w, top: o._raw.y, bottom: o._raw.y + o._raw.h };
        if (hit(abs, ob)) overlaps.push(w.kind + ' "' + w.label + '" overlaps ' + o.kind + ' "' + o.label + '"');
      });
      if (abs.top < box.top - 1 || abs.bottom > box.bottom + 1) {
        overlaps.push(w.kind + ' "' + w.label + '" sticks out of its line box (' + round(abs.top - box.top) + ', ' + round(abs.bottom - box.bottom) + ')');
      }
    });

    const guideColumns = [...(el.style.background || '').matchAll(/var\\(--editor-nesting-guide\\) (?:calc\\()*([\\d.]+)(?:ch| \\*)/g)]
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
      rowStarts: rowList.map((r) => round(r.start - contentLeft)),
      rowBaselines: rowList.map((r) => round(r.baseline)),
      widgets,
      overlaps
    };
  });

  return {
    chPx: round((body.ch + (parseFloat(lineStyle.letterSpacing) || 0)) * 100) / 100,
    capHeight: round(body.capHeight),
    xHeight: round(body.xHeight),
    fontFamily: lineStyle.fontFamily,
    fontSize: lineStyle.fontSize,
    lineHeight: lineStyle.lineHeight,
    contentLeft: round(contentLeft),
    // The editor can be laid out wider than the window (the app has minimum
    // widths); anything past the right edge is missing from screenshots.
    editorOverflow: round(Math.max(0, (document.querySelector('.cm-editor')?.getBoundingClientRect().right || 0) - innerWidth)),
    lines
  };
})()`;

/**
 * Runs in the renderer: given a viewport screenshot (base64 PNG) and a list
 * of CSS-px rects, returns the bounding box of the painted "ink" inside each
 * rect - pixels that differ from the rect's dominant (background) color.
 * That's what a glyph actually looks like on screen, which its element box
 * doesn't tell you (an icon font's box includes padding around the drawing).
 */
const INK_FN = `async (b64, rects, scale) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return rects.map((r) => {
    // Only measure what is fully on screen: a widget scrolled out of view, or
    // cut off by the window edge, would give a partial, misleading box.
    if (r.x < 0 || r.y < 0 || r.x + r.w > innerWidth || r.y + r.h > innerHeight) return null;
    // Round inward, so a fractional edge never takes in a pixel row of the
    // neighbouring line (e.g. its nesting guides).
    const x0 = Math.max(0, Math.ceil(r.x * scale));
    const y0 = Math.max(0, Math.ceil(r.y * scale));
    const w = Math.min(c.width - x0, Math.floor((r.x + r.w) * scale) - x0);
    const h = Math.min(c.height - y0, Math.floor((r.y + r.h) * scale) - y0);
    if (w <= 0 || h <= 0) return null;
    const d = ctx.getImageData(x0, y0, w, h).data;
    const counts = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let bg = 0, best = -1;
    for (const [k, n] of counts) if (n > best) { best = n; bg = k; }
    const br = bg >> 16, bgG = (bg >> 8) & 255, bb = bg & 255;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bb) > 90) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    return {
      left: (x0 + minX) / scale,
      right: (x0 + maxX + 1) / scale,
      top: (y0 + minY) / scale,
      bottom: (y0 + maxY + 1) / scale
    };
  });
}`;

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

        // Measure what the widgets actually painted, from a screenshot,
        // within each widget's own box. (The checkbox clips its drawing to
        // its box - overflow: hidden - so nothing it paints is outside it,
        // and a wider search picks up neighbouring lines' nesting guides.)
        type RawWidget = WidgetReport & { _raw: { x: number; y: number; w: number; h: number } };
        const all = report.lines.flatMap((l) => (l.widgets as RawWidget[]).map((w) => ({ w })));
        const rects = all.map(({ w }) => ({ x: w._raw.x, y: w._raw.y, w: w._raw.w, h: w._raw.h }));
        if (rects.length > 0) {
          const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          const inks = await evaluate<Array<WidgetReport['ink']>>(
            `(${INK_FN})(${JSON.stringify(shot.data)}, ${JSON.stringify(rects)}, ${scale})`
          );
          all.forEach(({ w }, k) => {
            const ink = inks[k];
            const left = report.contentLeft;
            w.ink = ink
              ? {
                  left: Math.round((ink.left - left) * 10) / 10,
                  right: Math.round((ink.right - left) * 10) / 10,
                  top: Math.round(ink.top * 10) / 10,
                  bottom: Math.round(ink.bottom * 10) / 10
                }
              : null;
            w.inkOffsetFromCapMiddle =
              ink && w.rowCapMiddle !== null
                ? Math.round(((ink.top + ink.bottom) / 2 - w.rowCapMiddle) * 10) / 10
                : null;
          });
        }
        for (const { w } of all) delete (w as Partial<RawWidget>)._raw;
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

      async placeCursorOnLine(index) {
        const point = await evaluate<{ x: number; y: number } | null>(
          `(() => {
            const line = document.querySelectorAll('.cm-content .cm-line')[${index - 1}];
            if (!line) return null;
            const r = line.getBoundingClientRect();
            return { x: r.right - 2, y: r.bottom - 6 };
          })()`
        );
        if (!point) throw new Error(`No rendered line ${index}`);
        await probe.click(point);
        await sleep(300);
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
  const ch = report.chPx;
  const col = (px: number): string => `${Math.round((px / ch) * 100) / 100}c`;
  const out = [
    `font ${report.fontSize} ${report.fontFamily} | column=${ch}px cap=${report.capHeight}px x=${report.xHeight}px | line-height ${report.lineHeight} | scale ${report.scale}x`,
    'x positions are from the content edge, also in character columns ("c", letter-spacing included). "ink" is what was painted;',
    'checkbox "dy" = ink center minus the cap-height middle of its row (negative = too high).',
    '',
    'line | pad indent | rows start at | guides (col) | text'
  ];
  if (report.editorOverflow > 0) {
    out.splice(
      1,
      0,
      `!! the editor is ${report.editorOverflow}px wider than the window: its right side is cut off in screenshots (use a larger --width)`
    );
  }
  for (const l of report.lines) {
    out.push(
      [
        String(l.index).padStart(4),
        `${l.paddingLeft} ${l.textIndent}`.padEnd(13),
        `[${l.rowStarts.map(col).join(', ')}]`.padEnd(18),
        `[${l.guideColumns.join(',')}]`.padEnd(10),
        JSON.stringify(l.text)
      ].join(' | ')
    );
    for (const w of l.widgets) {
      const ink = w.ink
        ? ` ink ${col(w.ink.left)}..${col(w.ink.right)}`
        : ' (not fully on screen: ink not measured)';
      const dy =
        w.kind === 'checkbox' && w.inkOffsetFromCapMiddle != null
          ? ` dy=${w.inkOffsetFromCapMiddle > 0 ? '+' : ''}${w.inkOffsetFromCapMiddle}px`
          : '';
      const vert =
        w.kind === 'pill' && w.rowCapMiddle != null
          ? ` box-mid-vs-cap-mid=${Math.round(((w.top + w.bottom) / 2 - w.rowCapMiddle) * 10) / 10}px`
          : '';
      out.push(
        `       ${w.kind} "${w.label}" box ${col(w.left)}..${col(w.right)} h=${w.height}${ink}${dy}${vert}`
      );
    }
    // Every line should be a whole number of rows tall - a widget that's
    // taller than the text (or sits too far up/down) makes its line taller.
    const lh = parseFloat(report.lineHeight);
    const rowsTall = Math.max(1, Math.round(l.height / lh));
    if (lh && Math.abs(l.height - rowsTall * lh) > 0.5) {
      out.push(
        `       !! line is ${l.height}px tall, not a whole number of ${report.lineHeight} rows`
      );
    }
    for (const o of l.overlaps) out.push(`       !! ${o}`);
  }
  return out.join('\n');
}

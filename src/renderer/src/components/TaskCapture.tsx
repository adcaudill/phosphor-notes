/**
 * The task capture field: type a task in plain language ("pay rent on the
 * first of each month !high #bills"), see exactly how it's read, press Enter.
 *
 * - Recognized pieces are highlighted in the input as you type, and a preview
 *   line underneath shows the task that will be created.
 * - Mod-Backspace turns the last recognized piece back into title text (by
 *   quoting it - quoted text is never parsed).
 * - Enter creates; Escape cancels without creating anything.
 *
 * Anchored under a point in the editor (inline `/task`), or centered as a
 * dialog (quick capture from anywhere). The parent does the creating, via
 * `onSubmit`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  parseTaskInput,
  toNewTaskInput,
  type ParsedTaskInput,
  type TokenKind
} from '../../../shared/taskParse';
import { describeRepeat } from '../../../shared/taskRepeat';
import { localDate } from '../../../shared/taskRecord';
import type { NewTaskInput } from '../../../shared/taskOps';
import { PRIORITY_LABEL, friendlyDueLabel } from '../utils/taskDisplay';
import '../styles/TaskCapture.css';

export interface TaskCaptureProps {
  /** Where to show it (under this rect); omit for a centered dialog. */
  anchorRect?: DOMRect | null;
  initialText?: string;
  /** Shown above the field, e.g. "Convert to task". */
  heading?: string;
  /** Creates the task. Rejecting keeps the field open and shows the error. */
  onSubmit: (input: NewTaskInput, parsed: ParsedTaskInput) => Promise<void>;
  onCancel: () => void;
}

const DATE_ORDER: 'mdy' | 'dmy' = (() => {
  // Numeric dates follow the system locale: 4/12 is April 12 in the US, 4 December elsewhere.
  try {
    const parts = new Intl.DateTimeFormat(undefined).formatToParts(new Date(2026, 11, 4));
    const first = parts.find((p) => p.type === 'day' || p.type === 'month');
    return first?.type === 'day' ? 'dmy' : 'mdy';
  } catch {
    return 'mdy';
  }
})();

const KIND_LABEL: Record<TokenKind, string> = {
  due: 'due',
  start: 'start',
  repeat: 'repeat',
  until: 'until',
  count: 'count',
  priority: 'priority',
  tag: 'tag',
  project: 'project',
  waiting: 'waiting'
};

function Preview({ parsed }: { parsed: ParsedTaskInput }): React.JSX.Element {
  const today = localDate();
  const chips: Array<{ kind: string; icon: string; text: string }> = [];
  if (parsed.due)
    chips.push({
      kind: 'due',
      icon: 'calendar_today',
      text: friendlyDueLabel(parsed.due, today).text
    });
  if (parsed.start)
    chips.push({
      kind: 'start',
      icon: 'flag',
      text: `starts ${friendlyDueLabel(parsed.start, today).text}`
    });
  if (parsed.repeat)
    chips.push({ kind: 'repeat', icon: 'repeat', text: describeRepeat(parsed.repeat) });
  if (parsed.priority)
    chips.push({ kind: 'priority', icon: 'priority_high', text: PRIORITY_LABEL[parsed.priority] });
  if (parsed.project) chips.push({ kind: 'project', icon: 'folder', text: parsed.project });
  for (const tag of parsed.tags) chips.push({ kind: 'tag', icon: 'sell', text: tag });
  if (parsed.waitingOn)
    chips.push({
      kind: 'waiting',
      icon: 'hourglass_empty',
      text: `waiting on ${parsed.waitingOn}`
    });

  return (
    <div className="task-capture-preview" aria-live="polite">
      <span className={`task-capture-preview-title ${parsed.title ? '' : 'empty'}`}>
        {parsed.title || 'Type a task…'}
      </span>
      {chips.map((c, i) => (
        <span key={i} className={`task-capture-chip task-capture-chip-${c.kind}`}>
          <span className="material-symbols-outlined">{c.icon}</span>
          {c.text}
        </span>
      ))}
      {parsed.notes.map((n, i) => (
        <span key={`n${i}`} className="task-capture-note">
          {n}
        </span>
      ))}
    </div>
  );
}

/** The input text with recognized pieces wrapped in highlight marks (drawn behind the input). */
function Highlights({
  text,
  parsed
}: {
  text: string;
  parsed: ParsedTaskInput;
}): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let at = 0;
  parsed.tokens.forEach((t, i) => {
    if (t.start > at) parts.push(text.slice(at, t.start));
    parts.push(
      <mark
        key={i}
        className={`task-capture-mark task-capture-mark-${t.kind}`}
        title={KIND_LABEL[t.kind]}
      >
        {text.slice(t.start, t.end)}
      </mark>
    );
    at = t.end;
  });
  parts.push(text.slice(at));
  // A trailing space keeps the mirror the same width as the input's text.
  parts.push(' ');
  return <>{parts}</>;
}

export function TaskCapture({
  anchorRect,
  initialText = '',
  heading,
  onSubmit,
  onCancel
}: TaskCaptureProps): React.JSX.Element {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseTaskInput(text, { dateOrder: DATE_ORDER }), [text]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  // Keep the highlight mirror scrolled with the input.
  useLayoutEffect(() => {
    if (mirrorRef.current && inputRef.current) {
      mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  });

  const submit = async (): Promise<void> => {
    if (busy || !parsed.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(toNewTaskInput(parsed), parsed);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
          : String(err)
      );
      setBusy(false);
    }
  };

  /** Quotes the last recognized piece, so it reads as title text instead. */
  const unparseLast = (): void => {
    const last = parsed.tokens.at(-1);
    if (!last) return;
    const raw = text.slice(last.start, last.end).replace(/"/g, '');
    setText(`${text.slice(0, last.start)}"${raw}"${text.slice(last.end)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && parsed.tokens.length > 0) {
      e.preventDefault();
      unparseLast();
    }
  };

  const style: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 528)),
        top: Math.min(anchorRect.bottom + 6, window.innerHeight - 140)
      }
    : {};

  const body = (
    <div
      className={`task-capture ${anchorRect ? 'task-capture-anchored' : 'task-capture-dialog'}`}
      style={style}
      role="dialog"
      aria-label={heading ?? 'New task'}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {heading && <div className="task-capture-heading">{heading}</div>}
      <div className="task-capture-field">
        <div className="task-capture-mirror" ref={mirrorRef} aria-hidden="true">
          <Highlights text={text} parsed={parsed} />
        </div>
        <input
          ref={inputRef}
          className="task-capture-input"
          value={text}
          placeholder="Pay rent on the first of each month !high #bills"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={() => {
            if (mirrorRef.current && inputRef.current) {
              mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
            }
          }}
          onBlur={(e) => {
            // Clicking outside cancels; moving focus within the capture doesn't.
            if (!e.currentTarget.closest('.task-capture')?.contains(e.relatedTarget as Node))
              onCancel();
          }}
        />
      </div>
      <Preview parsed={parsed} />
      <div className="task-capture-hints">
        {error ? (
          <span className="task-capture-error">{error}</span>
        ) : (
          <>
            <span>
              <kbd>Enter</kbd> create
            </span>
            <span>
              <kbd>Esc</kbd> cancel
            </span>
            {parsed.tokens.length > 0 && (
              <span>
                <kbd>⌘⌫</kbd> keep last piece as text
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (anchorRect) return ReactDOM.createPortal(body, document.body);
  return ReactDOM.createPortal(
    <div className="task-capture-backdrop" onMouseDown={onCancel}>
      {body}
    </div>,
    document.body
  );
}

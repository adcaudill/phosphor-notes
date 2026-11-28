/**
 * Everything about one task: title, status, fields, checklist, notes, the
 * activity timeline (with comments), and where it's mentioned.
 *
 * - `variant="popover"`: anchored next to a task link in the editor.
 * - `variant="panel"`: the Tasks tab's side panel.
 *
 * Every edit is written straight away through `window.phosphor.taskRecords`
 * (each one a history entry); the view refreshes from the task index. Fields
 * take plain language ("next fri", "every 2 weeks") and show how they were
 * read before saving. Keyboard: 1-5 set status, D/S/R/J/T jump to due, start,
 * repeat, project and tags, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { TaskDetail as TaskDetailData, TaskLinkLocation } from '../../../shared/taskViews';
import type {
  ChecklistItem,
  TaskLogEvent,
  TaskPriority,
  TaskRecord,
  TaskStatus
} from '../../../shared/taskRecord';
import { localDate } from '../../../shared/taskRecord';
import { describeRepeat } from '../../../shared/taskRepeat';
import { parseDatePhrase, parseRepeatPhrase } from '../../../shared/taskParse';
import type { TaskPatch } from '../../../shared/taskOps';
import { formatTaskLink } from '../../../shared/taskLinks';
import { subscribeTaskRecords, useTaskRecords } from '../tasks/taskRecordsStore';
import { friendlyDueLabel, PRIORITY_LABEL } from '../utils/taskDisplay';
import { TaskNotesEditor } from './TaskNotesEditor';
import '../styles/TaskDetail.css';

export interface TaskDetailProps {
  id: string;
  variant: 'popover' | 'panel';
  anchorRect?: DOMRect | null;
  /** The note open in the editor: link titles there are updated in the editor's buffer, not on disk. */
  currentFile?: string | null;
  onClose: () => void;
  /** After a rename: update this task's link titles in the open editor buffer. */
  onTitleChanged?: (id: string, title: string) => void;
  /** Open a note at a line ("mentioned in"). */
  onNavigate?: (note: string, line: number) => void;
  /** Offered in the panel: insert a link to this task into the open note. */
  onInsertLink?: (link: string) => void;
}

const STATUSES: Array<{ value: TaskStatus; label: string; icon: string }> = [
  { value: 'todo', label: 'To do', icon: 'check_box_outline_blank' },
  { value: 'doing', label: 'Doing', icon: 'indeterminate_check_box' },
  { value: 'waiting', label: 'Waiting', icon: 'pending' },
  { value: 'done', label: 'Done', icon: 'check_box' },
  { value: 'cancelled', label: 'Cancelled', icon: 'disabled_by_default' }
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 1, 2026" (+ " 14:30") - readable, and reads back as the same date. */
function dateForInput(value: string | undefined): string {
  if (!value) return '';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const time = value.length > 10 ? ` ${value.slice(11, 16)}` : '';
  return `${MONTHS[m - 1]} ${d}, ${y}${time}`;
}

function when(at: string): string {
  const d = new Date(at.length === 16 ? `${at}:00` : at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

const STATUS_NAME: Record<string, string> = Object.fromEntries(
  STATUSES.map((s) => [s.value, s.label])
);

function describeEvent(e: TaskLogEvent): string {
  switch (e.type) {
    case 'created':
      return 'Created';
    case 'status':
      return `${STATUS_NAME[String(e.from)] ?? e.from} → ${STATUS_NAME[String(e.to)] ?? e.to}`;
    case 'completed':
      return e.occurrence ? `Completed (due ${dateForInput(String(e.occurrence))})` : 'Completed';
    case 'skipped':
      return `Skipped the ${dateForInput(String(e.occurrence))} occurrence`;
    case 'rescheduled':
      if (!e.to) return 'Due date removed';
      if (!e.from) return `Due ${dateForInput(String(e.to))}`;
      return `Rescheduled ${dateForInput(String(e.from))} → ${dateForInput(String(e.to))}`;
    default:
      return e.type;
  }
}

/** A field that takes plain language and shows how it was read before saving. */
function PhraseField({
  label,
  hotkey,
  fieldRef,
  value,
  placeholder,
  interpret,
  onCommit
}: {
  label: string;
  hotkey: string;
  fieldRef: React.RefObject<HTMLInputElement | null>;
  /** The current value as text the field shows (and would read back the same). */
  value: string;
  placeholder: string;
  /** Reads typed text: what it would be saved as (label), or an error. Empty text clears. */
  interpret: (text: string) => { label: string; ok: true } | { ok: false; error: string };
  onCommit: (text: string) => Promise<void>;
}): React.JSX.Element {
  // A draft exists only while the field is being edited; otherwise it shows the saved value.
  const [editing, setEditing] = useState<string | null>(null);
  const draft = editing ?? value;
  const setDraft = (text: string): void => setEditing(text);
  const dirty = draft.trim() !== value.trim();
  const reading = dirty ? interpret(draft) : null;

  const commit = async (): Promise<void> => {
    if (!dirty) return;
    const r = interpret(draft);
    if (!r.ok) return;
    await onCommit(draft.trim());
  };

  return (
    <label className="task-detail-field">
      <span className="task-detail-field-label">
        {label} <kbd>{hotkey}</kbd>
      </span>
      <span className="task-detail-field-control">
        <input
          ref={fieldRef}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onFocus={() => setEditing(value)}
          onBlur={() => {
            void commit().finally(() => setEditing(null));
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit().then(() => (e.target as HTMLInputElement).blur());
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {reading && (
          <span className={`task-detail-field-reading ${reading.ok ? '' : 'error'}`}>
            {reading.ok ? reading.label : reading.error}
          </span>
        )}
      </span>
    </label>
  );
}

function Checklist({
  items,
  onChange
}: {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => Promise<void>;
}): React.JSX.Element {
  const [adding, setAdding] = useState('');
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const done = items.filter((i) => i.done).length;

  const update = (next: ChecklistItem[]): void => void onChange(next);
  const move = (i: number, by: number): void => {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
    setTimeout(() => refs.current[j]?.focus(), 0);
  };

  return (
    <section className="task-detail-section">
      <h4>
        Checklist{' '}
        {items.length > 0 && (
          <span className="task-detail-count">
            {done}/{items.length}
          </span>
        )}
      </h4>
      <ul className="task-detail-checklist">
        {items.map((item, i) => (
          <li key={i} className={item.done ? 'done' : ''}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() =>
                update(items.map((it, k) => (k === i ? { ...it, done: !it.done } : it)))
              }
            />
            <input
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="task-detail-checklist-text"
              defaultValue={item.text}
              key={`${i}:${item.text}`}
              onBlur={(e) => {
                const text = e.target.value.trim();
                if (!text) update(items.filter((_, k) => k !== i));
                else if (text !== item.text)
                  update(items.map((it, k) => (k === i ? { ...it, text } : it)));
              }}
              onKeyDown={(e) => {
                const input = e.target as HTMLInputElement;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  input.blur();
                } else if (e.key === 'Backspace' && input.value === '') {
                  e.preventDefault();
                  update(items.filter((_, k) => k !== i));
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(i, -1);
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, 1);
                }
              }}
            />
          </li>
        ))}
      </ul>
      <input
        className="task-detail-checklist-add"
        placeholder="Add a step…"
        value={adding}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && adding.trim()) {
            e.preventDefault();
            update([...items, { text: adding.trim(), done: false }]);
            setAdding('');
          }
        }}
      />
    </section>
  );
}

function Activity({
  log,
  onAdd,
  onEdit,
  onDelete
}: {
  log: TaskLogEvent[];
  onAdd: (text: string) => Promise<void>;
  onEdit: (at: string, text: string) => Promise<void>;
  onDelete: (at: string) => Promise<void>;
}): React.JSX.Element {
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const events = [...log].reverse();

  return (
    <section className="task-detail-section">
      <h4>Activity</h4>
      <textarea
        className="task-detail-comment-input"
        placeholder="Add a comment… (⌘↵ to post)"
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && comment.trim()) {
            e.preventDefault();
            void onAdd(comment).then(() => setComment(''));
          }
        }}
      />
      <ol className="task-detail-activity">
        {events.map((e) =>
          e.type === 'comment' ? (
            <li key={`${e.at}-c`} className="task-detail-comment">
              <div className="task-detail-comment-meta">
                {when(e.at)}
                {e.edited ? ' · edited' : ''}
                {editing !== e.at && (
                  <span className="task-detail-comment-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(e.at);
                        setEditText(String(e.text ?? ''));
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" onClick={() => void onDelete(e.at)}>
                      Delete
                    </button>
                  </span>
                )}
              </div>
              {editing === e.at ? (
                <textarea
                  className="task-detail-comment-input"
                  autoFocus
                  rows={2}
                  value={editText}
                  onChange={(ev) => setEditText(ev.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Escape') {
                      ev.stopPropagation();
                      setEditing(null);
                    } else if (
                      ev.key === 'Enter' &&
                      (ev.metaKey || ev.ctrlKey) &&
                      editText.trim()
                    ) {
                      ev.preventDefault();
                      void onEdit(e.at, editText).then(() => setEditing(null));
                    }
                  }}
                />
              ) : (
                <div className="task-detail-comment-text">{String(e.text ?? '')}</div>
              )}
            </li>
          ) : (
            <li key={`${e.at}-${e.type}`} className="task-detail-event">
              <span>{describeEvent(e)}</span>
              <span className="task-detail-event-when">{when(e.at)}</span>
            </li>
          )
        )}
      </ol>
    </section>
  );
}

function MentionedIn({
  links,
  onNavigate
}: {
  links: TaskLinkLocation[];
  onNavigate?: (note: string, line: number) => void;
}): React.JSX.Element {
  return (
    <section className="task-detail-section">
      <h4>Mentioned in</h4>
      {links.length === 0 ? (
        <p className="task-detail-muted">Not linked from any note.</p>
      ) : (
        <ul className="task-detail-links">
          {links.map((l, i) => (
            <li key={i}>
              <button type="button" onClick={() => onNavigate?.(l.note, l.line)}>
                <span className="material-symbols-outlined">description</span>
                {l.note.replace(/\.md$/, '')}
                <span className="task-detail-muted"> · line {l.line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TaskDetail({
  id,
  variant,
  anchorRect,
  currentFile,
  onClose,
  onTitleChanged,
  onNavigate,
  onInsertLink
}: TaskDetailProps): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetailData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // The title being edited (null when not editing: show the saved title).
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const waitingRef = useRef<HTMLInputElement>(null);
  const { tasks } = useTaskRecords();
  const api = window.phosphor.taskRecords;

  useEffect(() => {
    let current = true;
    const load = (): void => {
      api.get(id).then(
        (d) => {
          if (current) setDetail(d);
        },
        (err) => {
          if (current) setError(String(err));
        }
      );
    };
    load();
    const off = subscribeTaskRecords(load);
    return () => {
      current = false;
      off();
    };
  }, [api, id]);

  const task = detail?.task;

  const projects = useMemo(
    () => [...new Set(tasks.map((t) => t.project).filter(Boolean) as string[])].sort(),
    [tasks]
  );

  const run = async (op: () => Promise<TaskRecord | void>): Promise<void> => {
    setError(null);
    try {
      await op();
    } catch (err) {
      setError(
        String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': /, '')
      );
    }
  };
  const patch = (p: TaskPatch): Promise<void> => run(() => api.update(id, p));

  const saveTitle = async (): Promise<void> => {
    const title = (titleEdit ?? '').trim();
    setTitleEdit(null);
    if (!task || !title || title === task.title) return;
    await run(async () => {
      await api.update(id, { title });
      // Keep link text in step: the open note through its editor, the rest on disk.
      onTitleChanged?.(id, title);
      await api.syncLinkTitles(id, currentFile ? [currentFile] : []);
    });
  };

  const setStatus = (status: TaskStatus): Promise<void> =>
    status === 'done' ? run(() => api.complete(id)) : patch({ status });

  // Keyboard: status and field jumps when focus isn't in a text field.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA)$/.test(target.tagName) || target.closest('.cm-editor');
      if (e.key === 'Escape' && !typing) {
        e.preventDefault();
        onClose();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const status = STATUSES[Number(e.key) - 1];
      if (status) {
        e.preventDefault();
        void setStatus(status.value);
        return;
      }
      const jump: Record<string, React.RefObject<HTMLInputElement | null>> = {
        d: dueRef,
        s: startRef,
        r: repeatRef,
        j: projectRef,
        t: tagsRef
      };
      const ref = jump[e.key.toLowerCase()];
      if (ref?.current) {
        e.preventDefault();
        ref.current.focus();
        ref.current.select();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  });

  // The popover closes on Escape anywhere and on clicks outside it.
  useEffect(() => {
    if (variant !== 'popover') return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [variant, onClose]);

  // The popover takes focus when it opens; the Tasks tab's panel doesn't, so
  // the list keeps the keyboard while the selection moves.
  useEffect(() => {
    if (variant === 'popover') rootRef.current?.focus();
  }, [id, variant]);

  const today = localDate();
  let body: React.ReactNode;
  if (detail === undefined) {
    body = <p className="task-detail-muted">Loading…</p>;
  } else if (detail === null || !task) {
    body = (
      <div className="task-detail-missing">
        <p>This task no longer exists.</p>
        <p className="task-detail-muted">
          If it was deleted by mistake, it can be restored from history.
        </p>
      </div>
    );
  } else {
    const due = task.due;
    body = (
      <>
        <div className="task-detail-header">
          <input
            className={`task-detail-title ${task.status === 'done' || task.status === 'cancelled' ? 'finished' : ''}`}
            value={titleEdit ?? task.title}
            aria-label="Title"
            onFocus={() => setTitleEdit(task.title)}
            onChange={(e) => setTitleEdit(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setTitleEdit(task.title);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <button type="button" className="task-detail-close" onClick={onClose} title="Close (Esc)">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="task-detail-status" role="radiogroup" aria-label="Status">
          {STATUSES.map((s, i) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={task.status === s.value}
              className={`task-detail-status-btn status-${s.value} ${task.status === s.value ? 'active' : ''}`}
              onClick={() => void setStatus(s.value)}
              title={`${s.label} (${i + 1})`}
            >
              <span className="material-symbols-outlined">{s.icon}</span>
              {s.label}
            </button>
          ))}
          {task.repeat && task.due && task.status !== 'done' && task.status !== 'cancelled' && (
            <button
              type="button"
              className="task-detail-skip"
              onClick={() => void run(() => api.skip(id))}
            >
              Skip this one
            </button>
          )}
        </div>

        <div className="task-detail-fields">
          <PhraseField
            label="Due"
            hotkey="D"
            fieldRef={dueRef}
            value={dateForInput(due)}
            placeholder="fri, dec 4, tomorrow at 3pm"
            interpret={(text) => {
              if (!text.trim()) return { ok: true, label: 'No due date' };
              const d = parseDatePhrase(text);
              return d
                ? { ok: true, label: friendlyDueLabel(d, today).text }
                : { ok: false, error: 'Not a date' };
            }}
            onCommit={(text) => patch({ due: text ? parseDatePhrase(text) : null })}
          />
          <PhraseField
            label="Start"
            hotkey="S"
            fieldRef={startRef}
            value={dateForInput(task.start)}
            placeholder="when to start - hidden until then"
            interpret={(text) => {
              if (!text.trim()) return { ok: true, label: 'No start date' };
              const d = parseDatePhrase(text);
              return d
                ? { ok: true, label: friendlyDueLabel(d.slice(0, 10), today).text }
                : { ok: false, error: 'Not a date' };
            }}
            onCommit={(text) =>
              patch({ start: text ? (parseDatePhrase(text) ?? '').slice(0, 10) : null })
            }
          />
          <PhraseField
            label="Repeat"
            hotkey="R"
            fieldRef={repeatRef}
            value={task.repeat ? describeRepeat(task.repeat) : ''}
            placeholder="every mon, monthly on the 1st, every 3 days after done"
            interpret={(text) => {
              if (!text.trim()) return { ok: true, label: "Doesn't repeat" };
              const r = parseRepeatPhrase(text, { due });
              return r
                ? { ok: true, label: describeRepeat(r.repeat) }
                : { ok: false, error: 'Not a repeat' };
            }}
            onCommit={async (text) => {
              if (!text) return patch({ repeat: null });
              const r = parseRepeatPhrase(text, { due });
              if (r) await patch({ repeat: r.repeat, ...(due ? {} : { due: r.due }) });
            }}
          />
          <div className="task-detail-field">
            <span className="task-detail-field-label">Priority</span>
            <span className="task-detail-priority">
              {([undefined, 'low', 'medium', 'high'] as Array<TaskPriority | undefined>).map(
                (p) => (
                  <button
                    key={p ?? 'none'}
                    type="button"
                    className={`priority-${p ?? 'none'} ${task.priority === p ? 'active' : ''}`}
                    onClick={() => void patch({ priority: p ?? null })}
                  >
                    {p ? PRIORITY_LABEL[p].replace(' priority', '') : 'None'}
                  </button>
                )
              )}
            </span>
          </div>
          <PhraseField
            label="Project"
            hotkey="J"
            fieldRef={projectRef}
            value={task.project ?? ''}
            placeholder={projects.length ? projects.slice(0, 3).join(', ') : 'Home, Work…'}
            interpret={(text) => ({ ok: true, label: text.trim() ? text.trim() : 'No project' })}
            onCommit={(text) => patch({ project: text || null })}
          />
          <PhraseField
            label="Tags"
            hotkey="T"
            fieldRef={tagsRef}
            value={task.tags.map((t) => `#${t}`).join(' ')}
            placeholder="#errands #phone"
            interpret={(text) => {
              const tags = text
                .split(/[\s,]+/)
                .map((t) => t.replace(/^#/, ''))
                .filter(Boolean);
              return {
                ok: true,
                label: tags.length ? tags.map((t) => `#${t}`).join(' ') : 'No tags'
              };
            }}
            onCommit={(text) =>
              patch({
                tags: text
                  .split(/[\s,]+/)
                  .map((t) => t.replace(/^#/, ''))
                  .filter(Boolean)
              })
            }
          />
          {(task.status === 'waiting' || task.waitingOn) && (
            <PhraseField
              label="Waiting on"
              hotkey="-"
              fieldRef={waitingRef}
              value={task.waitingOn ?? ''}
              placeholder="who or what"
              interpret={(text) => ({ ok: true, label: text.trim() || 'Nobody' })}
              onCommit={(text) => patch({ waitingOn: text || null })}
            />
          )}
        </div>

        <Checklist items={task.checklist} onChange={(checklist) => patch({ checklist })} />

        <section className="task-detail-section">
          <h4>Notes</h4>
          <TaskNotesEditor key={id} value={task.notes} onSave={(notes) => void patch({ notes })} />
        </section>

        <Activity
          log={task.log}
          onAdd={(text) => run(() => api.addComment(id, text))}
          onEdit={(at, text) => run(() => api.editComment(id, at, text))}
          onDelete={(at) => run(() => api.deleteComment(id, at))}
        />

        <MentionedIn links={detail.links} onNavigate={onNavigate} />

        <div className="task-detail-actions">
          {onInsertLink && (
            <button type="button" onClick={() => onInsertLink(formatTaskLink(id, task.title))}>
              Insert link in note
            </button>
          )}
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(formatTaskLink(id, task.title))}
          >
            Copy link
          </button>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                await api.create({
                  title: `${task.title} (copy)`,
                  priority: task.priority,
                  due: task.due,
                  start: task.start,
                  repeat: task.repeat,
                  project: task.project,
                  tags: task.tags,
                  waitingOn: task.waitingOn,
                  notes: task.notes,
                  checklist: task.checklist.map((c) => ({ ...c, done: false }))
                });
              })
            }
          >
            Duplicate
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              const n = detail.links.length;
              const where = n
                ? ` It's linked from ${n} place${n === 1 ? '' : 's'}; those links will show it as missing.`
                : '';
              if (
                window.confirm(`Delete "${task.title}"?${where} It can be restored from history.`)
              ) {
                void run(async () => {
                  await api.delete(id);
                  onClose();
                });
              }
            }}
          >
            Delete
          </button>
        </div>
      </>
    );
  }

  const content = (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`task-detail task-detail-${variant}`}
      role="dialog"
      aria-label={task ? `Task: ${task.title}` : 'Task'}
      style={
        variant === 'popover' && anchorRect
          ? {
              position: 'fixed',
              left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 488)),
              // Under the link when there's room, otherwise as low as the
              // panel's max height (min(720px, 85vh), see CSS) allows.
              top: Math.max(
                8,
                Math.min(
                  anchorRect.bottom + 6,
                  window.innerHeight - Math.min(720, window.innerHeight * 0.85) - 8
                )
              )
            }
          : undefined
      }
    >
      {error && <div className="task-detail-error">{error}</div>}
      {body}
    </div>
  );

  return variant === 'popover' ? ReactDOM.createPortal(content, document.body) : content;
}

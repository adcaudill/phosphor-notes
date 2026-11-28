/**
 * Preview and convert inline checkbox tasks with metadata (📅 🔁 🔺 ✓,
 * @due, DEADLINE: ...) into task files - for the whole vault, or one note.
 * Shows what would change per note before anything is written; each changed
 * note can be restored from its history afterwards.
 */
import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { ConversionPreview, ConversionResult } from '../../../shared/taskViews';
import '../styles/TaskConversionDialog.css';

export interface TaskConversionDialogProps {
  /** Notes to convert; omit for the whole vault. */
  notes?: string[];
  /** Runs the conversion (the parent saves the open note first, and reloads it after). */
  onConvert: (notes?: string[]) => Promise<ConversionResult>;
  onClose: () => void;
}

export function TaskConversionDialog({
  notes,
  onConvert,
  onClose
}: TaskConversionDialogProps): React.JSX.Element {
  const [preview, setPreview] = useState<ConversionPreview | null>(null);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = (notes ?? []).join('\n');

  useEffect(() => {
    let current = true;
    window.phosphor.taskRecords.conversionPreview(scopeKey ? scopeKey.split('\n') : undefined).then(
      (p) => {
        if (current) setPreview(p);
      },
      (err) => {
        if (current) setError(String(err));
      }
    );
    return () => {
      current = false;
    };
  }, [scopeKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const convert = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(await onConvert(notes));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const folded = preview?.notes.reduce((n, p) => n + p.folded, 0) ?? 0;
  const scope = notes?.length === 1 ? notes[0].replace(/\.md$/, '') : 'your notes';

  return ReactDOM.createPortal(
    <div className="task-conversion-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="task-conversion"
        role="dialog"
        aria-label="Convert tasks"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Convert tasks to task files</h2>
        {result ? (
          <>
            <p>
              Created <strong>{result.tasksCreated}</strong> task
              {result.tasksCreated === 1 ? '' : 's'} in {result.notesChanged.length} note
              {result.notesChanged.length === 1 ? '' : 's'}. Each line is now a link to its task.
            </p>
            {result.skipped.length > 0 && (
              <div className="task-conversion-skipped">
                <p>Left unchanged (try again):</p>
                <ul>
                  {result.skipped.map((s) => (
                    <li key={s.note}>
                      {s.note} - {s.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="task-conversion-muted">
              Changed a note you didn&apos;t mean to? Its previous version is in the note&apos;s
              history.
            </p>
            <div className="task-conversion-actions">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="task-conversion-muted">
              Checkbox tasks in {scope} that have a due date, repeat, priority or completion time
              become task files, and each line becomes a link to its task. Plain checkboxes stay as
              checklist items.
            </p>
            {!preview && !error && <p>Looking for tasks…</p>}
            {preview && preview.tasks === 0 && (
              <p>There&apos;s nothing to convert - no checkbox tasks with dates or repeats.</p>
            )}
            {preview && preview.tasks > 0 && (
              <>
                <p>
                  <strong>{preview.tasks}</strong> task{preview.tasks === 1 ? '' : 's'} in{' '}
                  {preview.notes.length} note{preview.notes.length === 1 ? '' : 's'}
                  {folded > 0 &&
                    `, plus ${folded} completed repeat${folded === 1 ? '' : 's'} folded into ${
                      folded === 1 ? 'its' : 'their'
                    } task's history`}
                  .
                </p>
                <ul className="task-conversion-list">
                  {preview.notes.map((n) => (
                    <li key={n.note}>
                      <span className="task-conversion-note">{n.note.replace(/\.md$/, '')}</span>
                      <span className="task-conversion-count">
                        {n.tasks}
                        {n.folded ? ` (+${n.folded} history)` : ''}
                      </span>
                      <span className="task-conversion-samples">
                        {n.samples.join(' · ')}
                        {n.tasks > n.samples.length ? ' …' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {error && <p className="task-conversion-error">{error}</p>}
            <div className="task-conversion-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !preview || preview.tasks === 0}
                onClick={() => void convert()}
              >
                {busy
                  ? 'Converting…'
                  : `Convert ${preview?.tasks ?? ''} task${preview?.tasks === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

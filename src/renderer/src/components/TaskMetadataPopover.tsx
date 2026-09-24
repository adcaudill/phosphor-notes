import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import type { Priority, RecurrenceUnit } from '../../../shared/tasks';
import '../styles/TaskMetadataPopover.css';

export interface TaskMetadataValue {
  due?: string; // YYYY-MM-DD
  recurrence?: { amount: number; unit: RecurrenceUnit };
  priority?: Priority;
}

interface TaskMetadataPopoverProps {
  /** The clicked pill/affordance's bounding box, used to position the popover. */
  anchorRect: DOMRect;
  initial: TaskMetadataValue;
  /** Called immediately on every change - there's no separate "save" step. */
  onChange: (value: TaskMetadataValue) => void;
  onClose: () => void;
  /** When given, shows a link to jump to that date's daily note (e.g. "2026-11-01") - kept as a distinct, opt-in affordance rather than overloading the due-date click itself, which already means "edit." */
  onNavigateToDate?: (dateStr: string) => void;
}

const UNIT_OPTIONS: { value: RecurrenceUnit; label: string }[] = [
  { value: 'd', label: 'day' },
  { value: 'w', label: 'week' },
  { value: 'm', label: 'month' },
  { value: 'y', label: 'year' }
];

const PRIORITY_LEVELS: { value: Priority; icon: string; title: string }[] = [
  { value: 'high', icon: 'keyboard_double_arrow_up', title: 'High priority' },
  { value: 'medium', icon: 'remove', title: 'Medium priority' },
  { value: 'low', icon: 'keyboard_double_arrow_down', title: 'Low priority' }
];

function parseLocalDate(dateStr?: string): Date | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * A floating, click-triggered form for editing a task's due date,
 * recurrence, and priority without hand-typing emoji syntax - generalizes
 * the hand-rolled floating-tooltip pattern already used for wikilink hover
 * previews (InformationPanel.tsx) and menus (Sidebar.tsx) into the app's
 * first reusable interactive popover. Used identically by the editor (via
 * Editor.tsx) and the Tasks view, so both stay visually and behaviorally
 * consistent - every field writes back through the same shared
 * parser/serializer, never hand-building emoji text itself.
 */
export function TaskMetadataPopover({
  anchorRect,
  initial,
  onChange,
  onClose,
  onNavigateToDate
}: TaskMetadataPopoverProps): React.JSX.Element {
  const [due, setDue] = useState<Date | null>(parseLocalDate(initial.due));
  const [repeats, setRepeats] = useState<boolean>(Boolean(initial.recurrence));
  const [recurAmount, setRecurAmount] = useState<number>(initial.recurrence?.amount ?? 1);
  const [recurUnit, setRecurUnit] = useState<RecurrenceUnit>(initial.recurrence?.unit ?? 'd');
  const [priority, setPriority] = useState<Priority | undefined>(initial.priority);

  const panelRef = useRef<HTMLDivElement | null>(null);

  const emit = (
    nextDue: Date | null,
    nextRepeats: boolean,
    nextAmount: number,
    nextUnit: RecurrenceUnit,
    nextPriority: Priority | undefined
  ): void => {
    onChange({
      due: nextDue ? formatLocalDate(nextDue) : undefined,
      recurrence: nextDue && nextRepeats ? { amount: nextAmount, unit: nextUnit } : undefined,
      priority: nextPriority
    });
  };

  useEffect(() => {
    const handleOutside = (e: MouseEvent): void => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    // Attach on the next tick so the click that opened the popover doesn't
    // immediately register as an "outside" click and close it right away.
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handleOutside);
      document.addEventListener('keydown', handleKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const estimatedHeight = 380;
  const estimatedWidth = 280;
  const openUpward = anchorRect.bottom + estimatedHeight > viewportHeight;
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.max(8, Math.min(anchorRect.left, viewportWidth - estimatedWidth - 8)),
    ...(openUpward
      ? { bottom: Math.max(8, viewportHeight - anchorRect.top + 6) }
      : { top: anchorRect.bottom + 6 })
  };

  return ReactDOM.createPortal(
    <div className="task-metadata-popover" ref={panelRef} style={style}>
      <div className="task-metadata-section">
        <div className="task-metadata-label">Priority</div>
        <div className="task-metadata-priority-row">
          {PRIORITY_LEVELS.map(({ value, icon, title }) => (
            <button
              key={value}
              type="button"
              title={title}
              className={`task-metadata-priority-btn priority-${value} ${priority === value ? 'active' : ''}`}
              onClick={() => {
                const next = priority === value ? undefined : value;
                setPriority(next);
                emit(due, repeats, recurAmount, recurUnit, next);
              }}
            >
              <span className="material-symbols-outlined">{icon}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="task-metadata-section">
        <div className="task-metadata-label">Due date</div>
        <DatePicker
          selected={due}
          onChange={(d) => {
            setDue(d);
            const stillRepeats = d ? repeats : false;
            if (!d) setRepeats(false);
            emit(d, stillRepeats, recurAmount, recurUnit, priority);
          }}
          inline
          dateFormat="yyyy-MM-dd"
        />
        {due && (
          <div className="task-metadata-due-actions">
            <button
              type="button"
              className="task-metadata-clear-btn"
              onClick={() => {
                setDue(null);
                setRepeats(false);
                emit(null, false, recurAmount, recurUnit, priority);
              }}
            >
              Clear due date
            </button>
            {onNavigateToDate && (
              <button
                type="button"
                className="task-metadata-clear-btn"
                onClick={() => onNavigateToDate(formatLocalDate(due))}
              >
                Open journal for this date →
              </button>
            )}
          </div>
        )}
      </div>

      <div className="task-metadata-section">
        <label className="task-metadata-repeats-row">
          <input
            type="checkbox"
            checked={repeats}
            disabled={!due}
            onChange={(e) => {
              const next = e.target.checked;
              setRepeats(next);
              emit(due, next, recurAmount, recurUnit, priority);
            }}
          />
          Repeats
        </label>
        {repeats && due && (
          <div className="task-metadata-recur-row">
            <span>every</span>
            <input
              type="number"
              min={1}
              value={recurAmount}
              onChange={(e) => {
                const next = Math.max(1, parseInt(e.target.value, 10) || 1);
                setRecurAmount(next);
                emit(due, repeats, next, recurUnit, priority);
              }}
            />
            <select
              value={recurUnit}
              onChange={(e) => {
                const next = e.target.value as RecurrenceUnit;
                setRecurUnit(next);
                emit(due, repeats, recurAmount, next, priority);
              }}
            >
              {UNIT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                  {recurAmount === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </div>
        )}
        {!due && <div className="task-metadata-hint">Set a due date to enable recurrence.</div>}
      </div>
    </div>,
    document.body
  );
}

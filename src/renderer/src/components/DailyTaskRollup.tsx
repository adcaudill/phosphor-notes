import React, { useState } from 'react';
import { localDate } from '../../../shared/taskRecord';
import { dueNow } from '../../../shared/taskQuery';
import { useTaskRecords } from '../tasks/taskRecordsStore';
import { friendlyDueLabel } from '../utils/taskDisplay';
import { isDailyNote } from '../utils/frontmatterUtils';
import { TaskDetail } from './TaskDetail';
import '../styles/DailyTaskRollup.css';

interface DailyTaskRollupProps {
  currentFile: string | null;
  /** After a rename in the popover: update the task's link titles in the open note's buffer. */
  onTitleChanged?: (id: string, title: string) => void;
  onNavigate: (note: string, line: number) => void;
}

/**
 * A small collapsible "what's due" block shown at the top of the editor
 * when the open note is a daily journal - the point where the app owner
 * already looks every day. Lists overdue and due-today tasks (task files,
 * vault-wide); the checkbox completes one, and the title opens it.
 */
export function DailyTaskRollup({
  currentFile,
  onTitleChanged,
  onNavigate
}: DailyTaskRollupProps): React.JSX.Element | null {
  const { tasks } = useTaskRecords();
  const [collapsed, setCollapsed] = useState(false);
  // Not persisted anywhere on purpose - App.tsx remounts this component
  // (via a `key={currentFile}` on it) whenever the open file changes, so
  // dismissing it here only lasts until the next time this file is loaded.
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState<{ id: string; rect: DOMRect } | null>(null);

  if (!currentFile || !isDailyNote(currentFile) || dismissed) return null;

  const today = localDate();
  const relevant = dueNow(tasks, today);
  // Keep the popover for a task completed from inside it.
  if (relevant.length === 0 && !open) return null;

  const sorted = [...relevant].sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  const overdueCount = sorted.filter((t) => (t.due ?? '').slice(0, 10) < today).length;
  const api = window.phosphor.taskRecords;

  return (
    <div className="daily-task-rollup-container">
      <div className="daily-task-rollup">
        <button
          type="button"
          className="daily-task-rollup-header"
          onClick={() => setCollapsed((v) => !v)}
        >
          <span
            className={`material-symbols-outlined daily-task-rollup-chevron ${collapsed ? '' : 'open'}`}
          >
            chevron_right
          </span>
          <span className="material-symbols-outlined daily-task-rollup-icon">
            {overdueCount > 0 ? 'warning' : 'event_upcoming'}
          </span>
          <span className="daily-task-rollup-summary">
            {overdueCount > 0
              ? `${overdueCount} overdue, ${sorted.length - overdueCount} due today`
              : `${sorted.length} due today`}
          </span>
          <span
            className="daily-task-rollup-dismiss"
            onClick={(e) => {
              e.stopPropagation();
              setDismissed(true);
            }}
            title="Dismiss for now"
          >
            <span className="material-symbols-outlined">close</span>
          </span>
        </button>
        {!collapsed && sorted.length > 0 && (
          <div className="daily-task-rollup-list">
            {sorted.map((task) => {
              const overdue = (task.due ?? '').slice(0, 10) < today;
              return (
                <div
                  key={task.id}
                  className={`daily-task-rollup-item task-${task.status} ${overdue ? 'overdue' : ''}`}
                  onClick={(e) =>
                    setOpen({ id: task.id, rect: e.currentTarget.getBoundingClientRect() })
                  }
                >
                  <span
                    className="task-status-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      api
                        .complete(task.id)
                        .catch((err) => console.error('[Tasks] complete failed', err));
                    }}
                    title="Complete"
                  >
                    <span className="material-symbols-outlined">
                      {task.status === 'doing'
                        ? 'indeterminate_check_box'
                        : 'check_box_outline_blank'}
                    </span>
                  </span>
                  <span className="daily-task-rollup-text">{task.title}</span>
                  {task.due && (
                    <span className="daily-task-rollup-file">
                      {friendlyDueLabel(task.due, today).text}
                    </span>
                  )}
                  {task.project && <span className="daily-task-rollup-file">{task.project}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {open && (
        <TaskDetail
          key={open.id}
          id={open.id}
          variant="popover"
          anchorRect={open.rect}
          currentFile={currentFile}
          onClose={() => setOpen(null)}
          onTitleChanged={onTitleChanged}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

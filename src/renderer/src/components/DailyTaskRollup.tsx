import React, { useState } from 'react';
import type { Task } from '../../../shared/tasks';
import { todayString, isPastDate, isTodayDate } from '../../../shared/tasks';
import { isDailyNote } from '../utils/frontmatterUtils';
import '../styles/DailyTaskRollup.css';

interface DailyTaskRollupProps {
  currentFile: string | null;
  tasks: Task[];
  onToggleStatus: (task: Task) => void;
  onTaskClick: (filename: string, line: number) => void;
}

/**
 * A small collapsible "what's due" block shown at the top of the editor
 * when the open note is a daily journal - the point where the app owner
 * already looks every day, so it's the most direct way to connect "tasks"
 * and "notes and tasks live together" without a separate view. Lists
 * overdue and due-today tasks vault-wide (not just ones written in this
 * note), with the same inline status-cycling as the Tasks view.
 */
export function DailyTaskRollup({
  currentFile,
  tasks,
  onToggleStatus,
  onTaskClick
}: DailyTaskRollupProps): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  // Not persisted anywhere on purpose - App.tsx remounts this component
  // (via a `key={currentFile}` on it) whenever the open file changes, so
  // dismissing it here only lasts until the next time this file is loaded.
  const [dismissed, setDismissed] = useState(false);

  if (!currentFile || !isDailyNote(currentFile) || dismissed) return null;

  const today = todayString();
  const relevant = tasks.filter(
    (t) =>
      t.status !== 'done' &&
      t.dueDate &&
      (isPastDate(t.dueDate, today) || isTodayDate(t.dueDate, today))
  );
  if (relevant.length === 0) return null;

  const sorted = [...relevant].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const overdueCount = sorted.filter((t) => t.dueDate && isPastDate(t.dueDate, today)).length;

  return (
    <div className="daily-task-rollup">
      <button
        type="button"
        className="daily-task-rollup-header"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className={`material-symbols-outlined daily-task-rollup-chevron ${collapsed ? '' : 'open'}`}>
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
      {!collapsed && (
        <div className="daily-task-rollup-list">
          {sorted.map((task) => (
            <div
              key={`${task.file}-${task.line}`}
              className={`daily-task-rollup-item task-${task.status} ${task.dueDate && isPastDate(task.dueDate, today) ? 'overdue' : ''}`}
              onClick={() => onTaskClick(task.file, task.line)}
            >
              <span
                className="task-status-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStatus(task);
                }}
                title="Cycle status"
              >
                <span className="material-symbols-outlined">
                  {task.status === 'todo' ? 'check_box_outline_blank' : 'indeterminate_check_box'}
                </span>
              </span>
              <span className="daily-task-rollup-text">{task.text}</span>
              {task.file !== currentFile && (
                <span className="daily-task-rollup-file">{task.file}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import type { Task } from '../../../types/phosphor';
import '../styles/TasksView.css';

interface TasksViewProps {
  onTaskClick: (filename: string, line: number) => void;
}

interface GroupedTasks {
  [filename: string]: Task[];
}

type DateFilter = 'all' | 'overdue' | 'today' | 'upcoming' | 'no-date';

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayString(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a date is in the past
 */
function isPast(dateStr: string): boolean {
  return dateStr < getTodayString();
}

/**
 * Check if a date is today
 */
function isToday(dateStr: string): boolean {
  return dateStr === getTodayString();
}

/**
 * Get urgency category for a task
 */
function getUrgencyCategory(task: Task): 'overdue' | 'today' | 'upcoming' | 'no-date' {
  if (!task.dueDate) return 'no-date';
  if (isPast(task.dueDate)) return 'overdue';
  if (isToday(task.dueDate)) return 'today';
  return 'upcoming';
}

/**
 * Format a completion timestamp for display
 */
function formatCompletionTime(timestampStr: string): string {
  const [dateStr, timeStr] = timestampStr.split(' ');
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);

  const date = new Date(year, month - 1, day, hours, minutes);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

export const TasksView: React.FC<TasksViewProps> = ({ onTaskClick }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [groupedTasks, setGroupedTasks] = useState<GroupedTasks>({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'todo' | 'doing' | 'done'>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');

  useEffect(() => {
    const loadTasks = async (): Promise<void> => {
      try {
        setLoading(true);
        const taskIndex = await window.phosphor.getTaskIndex();
        setTasks(taskIndex || []);
      } catch (err) {
        console.error('Failed to load tasks:', err);
      } finally {
        setLoading(false);
      }
    };

    loadTasks();

    // Listen for task updates
    const unsubscribe = window.phosphor.onTasksUpdate((updatedTasks: Task[]) => {
      setTasks(updatedTasks);
    });

    return () => unsubscribe();
  }, []);

  // Group tasks by file and sort by urgency (always)
  useEffect(() => {
    const grouped: GroupedTasks = {};

    let tasksToGroup = [...tasks];

    // Always sort by urgency
    const urgencyOrder = { overdue: 0, today: 1, upcoming: 2, 'no-date': 3 };
    tasksToGroup.sort((a, b) => {
      const urgencyA = urgencyOrder[getUrgencyCategory(a)];
      const urgencyB = urgencyOrder[getUrgencyCategory(b)];
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
      // Within same urgency, sort by date, then by line
      if (a.dueDate && b.dueDate) {
        return a.dueDate.localeCompare(b.dueDate);
      }
      return a.line - b.line;
    });

    tasksToGroup.forEach((task) => {
      if (!grouped[task.file]) {
        grouped[task.file] = [];
      }
      grouped[task.file].push(task);
    });

    setGroupedTasks(grouped);
  }, [tasks]);

  const getStatusIcon = (status: 'todo' | 'doing' | 'done'): string => {
    switch (status) {
      case 'todo':
        return '○';
      case 'doing':
        return '◐';
      case 'done':
        return '✓';
    }
  };

  const getDueDateIcon = (urgency: 'overdue' | 'today' | 'upcoming' | 'no-date'): string => {
    switch (urgency) {
      case 'overdue':
        return '🔴';
      case 'today':
        return '🟠';
      case 'upcoming':
        return '🔵';
      case 'no-date':
        return '⚪';
    }
  };

  const filteredTasks = Object.entries(groupedTasks).reduce((acc, [filename, fileTasks]) => {
    let filtered = fileTasks;

    // Apply status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter((t) => t.status === statusFilter);
    }

    // Apply date filter
    if (dateFilter !== 'all') {
      filtered = filtered.filter((t) => getUrgencyCategory(t) === dateFilter);
    }

    if (filtered.length > 0) {
      acc[filename] = filtered;
    }
    return acc;
  }, {} as GroupedTasks);

  const totalTasks = Object.values(groupedTasks).reduce(
    (sum, fileTasks) => sum + fileTasks.length,
    0
  );
  const todoCount = tasks.filter((t) => t.status === 'todo').length;
  const doingCount = tasks.filter((t) => t.status === 'doing').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  const overdueCount = tasks.filter((t) => getUrgencyCategory(t) === 'overdue').length;
  const todayCount = tasks.filter((t) => getUrgencyCategory(t) === 'today').length;
  const upcomingCount = tasks.filter((t) => getUrgencyCategory(t) === 'upcoming').length;
  const noDueCount = tasks.filter((t) => getUrgencyCategory(t) === 'no-date').length;

  if (loading) {
    return <div className="tasks-view loading">Loading tasks...</div>;
  }

  return (
    <div className="tasks-view">
      <div className="tasks-header">
        <h2>Tasks</h2>
        <div className="tasks-stats">
          <span className="stat">
            <span className="stat-icon todo">○</span>
            {todoCount}
          </span>
          <span className="stat">
            <span className="stat-icon doing">◐</span>
            {doingCount}
          </span>
          <span className="stat">
            <span className="stat-icon done">✓</span>
            {doneCount}
          </span>
        </div>
      </div>

      <div className="tasks-filter">
        <div className="filter-group">
          <h4>Status</h4>
          <button
            className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All ({totalTasks})
          </button>
          <button
            className={`filter-btn ${statusFilter === 'todo' ? 'active' : ''}`}
            onClick={() => setStatusFilter('todo')}
          >
            Todo ({todoCount})
          </button>
          <button
            className={`filter-btn ${statusFilter === 'doing' ? 'active' : ''}`}
            onClick={() => setStatusFilter('doing')}
          >
            Doing ({doingCount})
          </button>
          <button
            className={`filter-btn ${statusFilter === 'done' ? 'active' : ''}`}
            onClick={() => setStatusFilter('done')}
          >
            Done ({doneCount})
          </button>
        </div>

        <div className="filter-group">
          <h4>Due Date</h4>
          <button
            className={`filter-btn ${dateFilter === 'all' ? 'active' : ''}`}
            onClick={() => setDateFilter('all')}
          >
            All
          </button>
          <button
            className={`filter-btn overdue ${dateFilter === 'overdue' ? 'active' : ''}`}
            onClick={() => setDateFilter('overdue')}
          >
            🔴 Overdue ({overdueCount})
          </button>
          <button
            className={`filter-btn today ${dateFilter === 'today' ? 'active' : ''}`}
            onClick={() => setDateFilter('today')}
          >
            🟠 Today ({todayCount})
          </button>
          <button
            className={`filter-btn upcoming ${dateFilter === 'upcoming' ? 'active' : ''}`}
            onClick={() => setDateFilter('upcoming')}
          >
            🔵 Upcoming ({upcomingCount})
          </button>
          <button
            className={`filter-btn no-date ${dateFilter === 'no-date' ? 'active' : ''}`}
            onClick={() => setDateFilter('no-date')}
          >
            ⚪ No Date ({noDueCount})
          </button>
        </div>
      </div>

      <div className="tasks-list">
        {Object.entries(filteredTasks).length === 0 ? (
          <div className="empty-state">
            {statusFilter === 'done' && doneCount === 0 ? (
              <>
                <p>✨ No completed tasks yet</p>
                <p style={{ fontSize: '14px', opacity: 0.6 }}>
                  Mark tasks as done to see them here
                </p>
              </>
            ) : (
              <>
                <p>📋 No tasks found</p>
                <p style={{ fontSize: '14px', opacity: 0.6 }}>
                  Add tasks using GFM syntax: - [ ] Task text
                </p>
              </>
            )}
          </div>
        ) : (
          Object.entries(filteredTasks).map(([filename, fileTasks]) => (
            <div key={filename} className="task-file-group">
              <div className="task-file-header">
                <span className="file-name">{filename}</span>
                <span className="file-count">{fileTasks.length} task(s)</span>
              </div>
              <div className="task-items">
                {fileTasks.map((task, idx) => (
                  <div
                    key={`${filename}-${idx}`}
                    className={`task-item task-${task.status}`}
                    onClick={() => onTaskClick(filename, task.line)}
                  >
                    <span className="task-status-icon">{getStatusIcon(task.status)}</span>
                    <span className="task-text">{task.text}</span>
                    {task.status === 'done' && task.completedAt && (
                      <span className="task-completed-time">
                        Completed {formatCompletionTime(task.completedAt)}
                      </span>
                    )}
                    {task.dueDate && (
                      <>
                        <span className="task-due-date-icon">
                          {getDueDateIcon(getUrgencyCategory(task))}
                        </span>
                        <span className="task-due-date">{task.dueDate}</span>
                      </>
                    )}
                    <span className="task-line">L{task.line}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

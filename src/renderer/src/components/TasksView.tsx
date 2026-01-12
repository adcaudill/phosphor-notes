import React, { useEffect, useState } from 'react';
import type { Task } from '../../../types/phosphor';
import '../styles/TasksView.css';

interface TasksViewProps {
  onTaskClick: (filename: string, line: number) => void;
}

interface GroupedTasks {
  [filename: string]: Task[];
}

export const TasksView: React.FC<TasksViewProps> = ({ onTaskClick }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [groupedTasks, setGroupedTasks] = useState<GroupedTasks>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'todo' | 'doing' | 'done'>('all');

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

  // Group tasks by file whenever they change
  useEffect(() => {
    const grouped: GroupedTasks = {};

    tasks.forEach((task) => {
      if (!grouped[task.file]) {
        grouped[task.file] = [];
      }
      grouped[task.file].push(task);
    });

    // Sort tasks within each file by line number
    Object.keys(grouped).forEach((filename) => {
      grouped[filename].sort((a, b) => a.line - b.line);
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

  const filteredTasks = Object.entries(groupedTasks).reduce((acc, [filename, fileTasks]) => {
    const filtered = filter === 'all' ? fileTasks : fileTasks.filter((t) => t.status === filter);
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
        <button
          className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({totalTasks})
        </button>
        <button
          className={`filter-btn ${filter === 'todo' ? 'active' : ''}`}
          onClick={() => setFilter('todo')}
        >
          Todo ({todoCount})
        </button>
        <button
          className={`filter-btn ${filter === 'doing' ? 'active' : ''}`}
          onClick={() => setFilter('doing')}
        >
          Doing ({doingCount})
        </button>
        <button
          className={`filter-btn ${filter === 'done' ? 'active' : ''}`}
          onClick={() => setFilter('done')}
        >
          Done ({doneCount})
        </button>
      </div>

      <div className="tasks-list">
        {Object.entries(filteredTasks).length === 0 ? (
          <div className="empty-state">
            {filter === 'done' && doneCount === 0 ? (
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

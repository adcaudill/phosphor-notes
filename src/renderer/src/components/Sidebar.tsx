import React, { useState, useEffect } from 'react';

interface SidebarProps {
  onFileSelect: (filename: string) => void;
  onTasksClick?: () => void;
  onEditorClick?: () => void;
  activeFile: string | null;
  isDirty: boolean;
  refreshSignal?: number;
  viewMode?: 'editor' | 'tasks';
}

export const Sidebar: React.FC<SidebarProps> = ({
  onFileSelect,
  onTasksClick,
  onEditorClick,
  activeFile,
  isDirty,
  refreshSignal,
  viewMode = 'editor'
}) => {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    const fetchFiles = async () => {
      const fileList = await window.phosphor.listFiles();
      setFiles(fileList);
    };

    fetchFiles();
  }, [refreshSignal]);

  return (
    <div className="sidebar">
      <div className="sidebar-drag-area" />
      <div className="sidebar-nav">
        <button
          className={`nav-btn ${viewMode === 'editor' ? 'active' : ''}`}
          onClick={onEditorClick}
          title="Editor view"
        >
          📝
        </button>
        <button
          className={`nav-btn ${viewMode === 'tasks' ? 'active' : ''}`}
          onClick={onTasksClick}
          title="Tasks view"
        >
          ✓
        </button>
      </div>
      <h2>Notes</h2>
      <ul>
        {files.map((file) => (
          <li
            key={file}
            className={file === activeFile ? 'active' : ''}
            onClick={() => {
              try {
                console.debug('Sidebar click:', file);
              } catch {}
              onFileSelect(file);
            }}
          >
            {file}
            {file === activeFile && isDirty && <span className="dirty-indicator">•</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

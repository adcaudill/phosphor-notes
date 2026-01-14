import React, { useState, useEffect } from 'react';

interface SidebarProps {
  onFileSelect: (filename: string) => void;
  onTasksClick?: () => void;
  onEditorClick?: () => void;
  onGraphClick?: () => void;
  activeFile: string | null;
  isDirty: boolean;
  refreshSignal?: number;
  viewMode?: 'editor' | 'tasks' | 'graph';
}

export const Sidebar: React.FC<SidebarProps> = ({
  onFileSelect,
  onTasksClick,
  onEditorClick,
  onGraphClick,
  activeFile,
  isDirty,
  refreshSignal,
  viewMode = 'editor'
}) => {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    const fetchMRUFiles = async (): Promise<void> => {
      const mruList = await window.phosphor.getMRUFiles();
      setFiles(mruList);
    };

    fetchMRUFiles();
  }, [refreshSignal]);

  const openDaily = async (): Promise<void> => {
    try {
      const dailyFilename = await window.phosphor.getDailyNoteFilename();
      // If we're currently in tasks or graph view, switch to editor first
      if (viewMode !== 'editor' && onEditorClick) {
        onEditorClick();
      }
      // Update MRU when daily note is opened
      try {
        const updatedMRU = await window.phosphor.updateMRU(dailyFilename);
        setFiles(updatedMRU);
      } catch (err) {
        console.debug('Failed to update MRU:', err);
      }
      onFileSelect(dailyFilename);
    } catch (err) {
      console.debug('Failed to open daily note:', err);
    }
  };

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
        <button
          className={`nav-btn ${viewMode === 'graph' ? 'active' : ''}`}
          onClick={onGraphClick}
          title="Graph view"
        >
          🕸️
        </button>
      </div>
      <h2
        className="daily-heading"
        role="button"
        tabIndex={0}
        onClick={openDaily}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openDaily();
          }
        }}
        title="Open today's daily note"
      >
        Daily
      </h2>
      <h2>Recent</h2>
      <ul>
        {files.map((file) => (
          <li
            key={file}
            className={file === activeFile ? 'active' : ''}
            onClick={async () => {
              try {
                console.debug('Sidebar click:', file);
              } catch (err) {
                console.debug('Sidebar click error:', err);
              }
              // If we're currently in tasks or graph view, switch to editor first
              if (viewMode !== 'editor' && onEditorClick) {
                onEditorClick();
              }
              // Update MRU when file is selected
              try {
                const updatedMRU = await window.phosphor.updateMRU(file);
                setFiles(updatedMRU);
              } catch (err) {
                console.debug('Failed to update MRU:', err);
              }
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

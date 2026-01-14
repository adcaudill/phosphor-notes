import React, { useState, useEffect, useRef } from 'react';

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
  const [isFading, setIsFading] = useState(false);
  const [isClickDisabled, setIsClickDisabled] = useState(false);
  const fadeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const fetchMRUFiles = async (): Promise<void> => {
      const mruList = await window.phosphor.getMRUFiles();
      setFiles(mruList);
    };

    fetchMRUFiles();
  }, [refreshSignal]);

  useEffect(() => {
    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
    };
  }, []);

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

  const performFadeTransition = async (file: string): Promise<void> => {
    // Disable clicks and start fade out
    setIsClickDisabled(true);
    setIsFading(true);

    // Wait for fade out to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Switch view if needed
    if (viewMode !== 'editor' && onEditorClick) {
      onEditorClick();
    }

    // Update MRU
    try {
      const updatedMRU = await window.phosphor.updateMRU(file);
      setFiles(updatedMRU);
    } catch (err) {
      console.debug('Failed to update MRU:', err);
    }

    // Trigger the file selection
    onFileSelect(file);

    // Fade back in
    setIsFading(false);

    // Re-enable clicks after fade completes
    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current);
    }
    fadeTimeoutRef.current = setTimeout(() => {
      setIsClickDisabled(false);
    }, 100);
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
      <ul className={isFading ? 'fade-out' : ''}>
        {files.map((file) => (
          <li
            key={file}
            className={file === activeFile ? 'active' : ''}
            onClick={() => {
              if (!isClickDisabled) {
                performFadeTransition(file);
              }
            }}
            style={{
              pointerEvents: isClickDisabled ? 'none' : 'auto',
              opacity: isFading ? 0.5 : 1,
              transition: 'opacity 300ms ease-in-out'
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

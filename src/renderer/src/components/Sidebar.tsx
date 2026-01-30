import React, { useState, useEffect, useRef } from 'react';
import 'material-symbols';
import '../styles/Sidebar.css';

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
  const [favorites, setFavorites] = useState<string[]>([]);
  const [isFading, setIsFading] = useState(false);
  const [isClickDisabled, setIsClickDisabled] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const fadeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const fetchMRUFiles = async (): Promise<void> => {
      const mruList = await window.phosphor.getMRUFiles();
      setFiles(mruList);
    };

    const fetchFavorites = async (): Promise<void> => {
      try {
        const fav = await window.phosphor.getFavorites();
        setFavorites(fav);
      } catch (err) {
        console.debug('Failed to load favorites:', err);
      }
    };

    fetchMRUFiles();
    fetchFavorites();

    const unsub = window.phosphor.onFavoritesChange?.((updated: string[]) => {
      setFavorites(updated);
    });

    return () => {
      if (unsub) unsub();
    };
  }, [refreshSignal]);

  useEffect(() => {
    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
    };
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
    return undefined;
  }, [isMenuOpen]);

  const openDaily = async (): Promise<void> => {
    try {
      const dailyFilename = await window.phosphor.getDailyNoteFilename();
      // If we're currently in tasks or graph view, switch to editor first
      if (viewMode !== 'editor' && onEditorClick) {
        onEditorClick();
      }
      // If we're not in editor view, switch to editor
      if (viewMode !== 'editor' && onEditorClick) {
        onEditorClick();
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

  const handleMenuClick = (action: string): void => {
    window.phosphor.triggerMenuAction(action);
    setIsMenuOpen(false);
  };

  return (
    <div className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-drag-area" />
        <div className="sidebar-nav-wrapper" ref={menuRef}>
          <button className="hamburger-btn" title="Menu" onClick={() => setIsMenuOpen(!isMenuOpen)}>
            <span className="material-symbols-outlined">menu</span>
          </button>
          {isMenuOpen && (
            <div className="hamburger-menu">
              <button className="menu-item" onClick={() => handleMenuClick('menu:preferences')}>
                <span className="material-symbols-outlined">settings</span>
                Preferences
              </button>
              <div className="menu-separator" />
              <button className="menu-item" onClick={() => handleMenuClick('menu:open-vault')}>
                <span className="material-symbols-outlined">folder_open</span>
                Open Vault
              </button>
              <button
                className="menu-item"
                onClick={() => handleMenuClick('menu:enable-encryption')}
              >
                <span className="material-symbols-outlined">lock</span>
                Enable Encryption
              </button>
              <button className="menu-item" onClick={() => handleMenuClick('menu:lock-vault')}>
                <span className="material-symbols-outlined">lock_clock</span>
                Lock Vault
              </button>
              <button className="menu-item" onClick={() => handleMenuClick('menu:import-logseq')}>
                <span className="material-symbols-outlined">upload</span>
                Import Logseq
              </button>
              <div className="menu-separator" />
              <button className="menu-item" onClick={() => handleMenuClick('menu:graph-stats')}>
                <span className="material-symbols-outlined">analytics</span>
                Graph Information
              </button>
              <button className="menu-item" onClick={() => handleMenuClick('menu:about')}>
                <span className="material-symbols-outlined">info</span>
                About
              </button>
            </div>
          )}
          <div className="sidebar-nav">
            <button
              className={`nav-btn ${viewMode === 'editor' ? 'active' : ''}`}
              onClick={onEditorClick}
              title="Editor view"
            >
              <span className="material-symbols-outlined">edit_note</span>
            </button>
            <button
              className={`nav-btn ${viewMode === 'tasks' ? 'active' : ''}`}
              onClick={onTasksClick}
              title="Tasks view"
            >
              <span className="material-symbols-outlined">task</span>
            </button>
            <button
              className={`nav-btn ${viewMode === 'graph' ? 'active' : ''}`}
              onClick={onGraphClick}
              title="Graph view"
            >
              <span className="material-symbols-outlined">graph_3</span>
            </button>
          </div>
        </div>
        <h2
          className="daily-heading vcenter-text"
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
          <span className="material-symbols-outlined">calendar_today</span>
          Daily
        </h2>
      </div>

      <div className="sidebar-body">
        <h2 className="vcenter-text">
          <span className="material-symbols-outlined">bookmarks</span>Favorites
        </h2>
        <ul>
          {favorites.map((file) => (
            <li
              key={file}
              className={file === activeFile ? 'active' : ''}
              onClick={() => {
                if (!isClickDisabled) {
                  performFadeTransition(file);
                }
              }}
              style={{
                pointerEvents: isClickDisabled ? 'none' : 'auto'
              }}
            >
              {file}
              {file === activeFile && isDirty && <span className="dirty-indicator">•</span>}
            </li>
          ))}
        </ul>
        <h2 className="vcenter-text">
          <span className="material-symbols-outlined">history</span>Recent
        </h2>
        <ul className={isFading ? 'fade-out' : ''}>
          {files
            .filter((file) => !favorites.includes(file))
            .map((file) => (
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
    </div>
  );
};

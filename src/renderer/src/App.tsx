import React, { useState, useEffect, useRef } from 'react';
import { Editor } from './components/Editor';
import { Sidebar } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import { RelationshipsPanel } from './components/RelationshipsPanel';
import { CommandPalette } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { TasksView } from './components/TasksView';
import { SettingsProvider } from './contexts/SettingsContext';
import { useSettings } from './hooks/useSettings';
import './styles/colorPalettes.css';

/**
 * Extract title from markdown frontmatter, or fallback to filename
 */
function getTitleFromContent(content: string, filename: string | null): string {
  if (!filename) return 'No file selected';

  // Try to extract title from frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const titleMatch = frontmatter.match(/title:\s*["']?([^"\'\n]+)["']?/);
    if (titleMatch) {
      return titleMatch[1].trim();
    }
  }

  // Fallback to filename without extension
  return filename.replace(/\.md$/, '');
}

function AppContent(): React.JSX.Element {
  const { settings } = useSettings();
  const [content, setContent] = useState('');
  const [vaultName, setVaultName] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [filesVersion, setFilesVersion] = useState<number>(0);
  const debounceTimer = useRef<number | null>(null);
  const [graph, setGraph] = useState<Record<string, string[]>>({});
  const [backlinks, setBacklinks] = useState<Record<string, string[]>>({});
  const skipSaveRef = useRef<boolean>(false);
  const [status, setStatus] = useState<{ type: string; message: string } | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null); // Filename that has a conflict
  const [isDirty, setIsDirty] = useState(false); // Whether current file has unsaved changes
  const [viewMode, setViewMode] = useState<'editor' | 'tasks'>('editor'); // Switch between editor and tasks view
  const [showRelationshipsSidebar, setShowRelationshipsSidebar] = useState(false); // Toggle for relationships sidebar

  // Apply color palette and theme to the document
  useEffect(() => {
    const html = document.documentElement;

    // Determine the effective theme (resolve 'system' to actual light/dark)
    let effectiveTheme = settings.theme;
    if (settings.theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      effectiveTheme = prefersDark ? 'dark' : 'light';
    }

    // Apply color palette and theme mode attributes
    html.setAttribute('data-color-palette', settings.colorPalette);
    html.setAttribute('data-theme-mode', effectiveTheme);
  }, [settings.theme, settings.colorPalette]);

  useEffect(() => {
    const init = async (): Promise<void> => {
      // If main already opened a vault (auto-open), prefer that over prompting
      const current = await window.phosphor.getCurrentVault?.();
      let selectedVault = current;
      if (!selectedVault) {
        selectedVault = await window.phosphor.selectVault();
      }

      if (selectedVault) {
        setVaultName(selectedVault);
        const dailyNoteFilename = await window.phosphor.getDailyNoteFilename();
        setCurrentFile(dailyNoteFilename);
        const noteContent = await window.phosphor.readNote(dailyNoteFilename);
        setContent(noteContent);
      } else {
        console.log('No vault selected');
      }

      // Load cached graph (in case main sent it before renderer subscribed)
      try {
        const cached = await window.phosphor.getCachedGraph?.();
        console.debug('Cached graph loaded (raw):', cached ? Object.keys(cached).length : 0);
        if (cached) {
          setGraph(cached);
          const bl: Record<string, string[]> = {};
          Object.entries(cached).forEach(([source, links]) => {
            links.forEach((target) => {
              if (!bl[target]) bl[target] = [];
              bl[target].push(source);
            });
          });
          setBacklinks(bl);
          console.debug('Backlinks computed from cached graph, keys:', Object.keys(bl).length);
        }
      } catch (e) {
        console.warn('Failed to load cached graph', e);
      }
    };
    init();

    // subscribe to graph updates
    const unsubscribe = window.phosphor.onGraphUpdate((graphData) => {
      console.debug('Received graph update, raw keys:', Object.keys(graphData).length, graphData);
      setGraph(graphData);
      const bl: Record<string, string[]> = {};
      Object.entries(graphData).forEach(([source, links]) => {
        links.forEach((target) => {
          if (!bl[target]) bl[target] = [];
          bl[target].push(source);
        });
      });
      setBacklinks(bl);
      console.debug('Backlinks keys:', Object.keys(bl).slice(0, 50));
    });

    // subscribe to status updates
    const unsubscribeStatus = window.phosphor.onStatusUpdate((s) => {
      setStatus(s);
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = window.setTimeout(() => setStatus(null), 4000) as unknown as number;
    });

    // Handle Cmd+K / Ctrl+K to open command palette, Cmd+, to open settings
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    // Menu event listeners
    const unsubscribeNewNote = window.phosphor.onMenuEvent?.('menu:new-note', async () => {
      const timestamp = new Date().toISOString().split('T')[0];
      let index = 1;
      let filename = `Untitled ${timestamp}.md`;

      // Try numbered names if file exists
      while (true) {
        try {
          await window.phosphor.readNote(filename);
          index++;
          filename = `Untitled ${timestamp} ${index}.md`;
        } catch {
          // File doesn't exist, use this name
          break;
        }
      }

      const newContent = '---\ntags: []\n---\n\n';
      await window.phosphor.saveNote(filename, newContent);
      setCurrentFile(filename);
      setContent(newContent);
      skipSaveRef.current = false;
      setFilesVersion((v) => v + 1);
    });

    const unsubscribeSave = window.phosphor.onMenuEvent?.('menu:save', () => {
      if (currentFile) {
        window.phosphor.saveNote(currentFile, content);
      }
    });

    const unsubscribeSearch = window.phosphor.onMenuEvent?.('menu:search', () => {
      setCommandPaletteOpen(true);
    });

    const unsubscribeToggleSidebar = window.phosphor.onMenuEvent?.('menu:toggle-sidebar', () => {
      // Sidebar toggle logic will be added here
      console.log('Toggle sidebar requested');
    });

    const unsubscribePreferences = window.phosphor.onMenuEvent?.('menu:preferences', () => {
      setSettingsOpen(true);
    });

    // File change watchers - external file modifications
    const unsubscribeFileChanged = window.phosphor.onFileChanged?.((filename: string) => {
      console.debug('[FileWatcher] File changed externally:', filename);

      // Check if this is the currently open file
      if (filename === currentFile) {
        if (isDirty) {
          // User has unsaved changes - show conflict banner
          console.warn('[FileWatcher] Conflict detected for:', filename);
          setConflict(filename);
        } else {
          // Safe to reload - just update content silently
          console.debug('[FileWatcher] Reloading content for:', filename);
          window.phosphor.readNote(filename).then((newContent) => {
            skipSaveRef.current = true;
            setContent(newContent);
            setTimeout(() => {
              skipSaveRef.current = false;
            }, 100);
          });
        }
      }
      // If it's a different file, refresh sidebar to show updated state
      setFilesVersion((v) => v + 1);
    });

    const unsubscribeFileDeleted = window.phosphor.onFileDeleted?.((filename: string) => {
      console.debug('[FileWatcher] File deleted externally:', filename);

      // If currently open file was deleted, clear it
      if (filename === currentFile) {
        setContent('');
        setCurrentFile(null);
        setConflict(null);
        setStatus({ type: 'warning', message: `File deleted: ${filename}` });
      }

      // Refresh sidebar
      setFilesVersion((v) => v + 1);
    });

    const unsubscribeFileAdded = window.phosphor.onFileAdded?.((filename: string) => {
      console.debug('[FileWatcher] File added externally:', filename);
      // Refresh sidebar to show new file
      setFilesVersion((v) => v + 1);
    });

    // Listen for app quit check and respond with unsaved status
    const unsubscribeCheckUnsaved = window.phosphor.onCheckUnsavedChanges?.(() => {
      return isDirty; // Return whether there are unsaved changes
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (unsubscribe) unsubscribe();
      if (unsubscribeStatus) unsubscribeStatus();
      if (unsubscribeNewNote) unsubscribeNewNote();
      if (unsubscribeSave) unsubscribeSave();
      if (unsubscribeSearch) unsubscribeSearch();
      if (unsubscribeToggleSidebar) unsubscribeToggleSidebar();
      if (unsubscribeFileChanged) unsubscribeFileChanged();
      if (unsubscribeFileDeleted) unsubscribeFileDeleted();
      if (unsubscribeFileAdded) unsubscribeFileAdded();
      if (unsubscribeCheckUnsaved) unsubscribeCheckUnsaved();
      if (unsubscribePreferences) unsubscribePreferences();
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  const handleContentChange = (newContent: string): void => {
    setContent(newContent);
    setIsDirty(true); // Mark as having unsaved changes
    if (skipSaveRef.current) return; // skip saving when content is being programmatically loaded
    if (currentFile) {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = window.setTimeout(() => {
        if (currentFile) {
          window.phosphor.saveNote(currentFile, newContent);
          setIsDirty(false); // Mark as saved
        }
      }, 500) as unknown as number;
    }
  };

  const handleFileSelect = async (filename: string): Promise<void> => {
    try {
      console.debug('handleFileSelect invoked for', filename);
      const noteContent = await window.phosphor.readNote(filename);
      // Prevent the programmatic content load from triggering a save
      skipSaveRef.current = true;
      setContent(noteContent);
      setCurrentFile(filename);
      setConflict(null); // Clear conflict if switching files
      setIsDirty(false); // New file is not dirty
      // Allow saves after the debounce window
      setTimeout(() => {
        skipSaveRef.current = false;
      }, 600);
    } catch (err) {
      console.error('Failed to read note', filename, err);
    }
  };

  useEffect(() => {
    console.debug('Current file changed ->', currentFile);
    if (currentFile) {
      const list = backlinks[currentFile] || [];
      console.debug(`Backlinks for ${currentFile}:`, list.length, list);
    }
  }, [currentFile]);

  useEffect(() => {
    console.debug('Backlinks changed ->', backlinks);
  }, [backlinks]);

  const handleLinkClick = async (linkText: string): Promise<void> => {
    const filename = linkText.endsWith('.md') ? linkText : `${linkText}.md`;
    // readNote will create the file if missing (per main IPC behavior)
    const content = await window.phosphor.readNote(filename);
    setCurrentFile(filename);
    setContent(content);
    // Trigger a save to ensure it appears in sidebar immediately
    await window.phosphor.saveNote(filename, content);
    // Bump filesVersion so Sidebar re-fetches
    setFilesVersion((v) => v + 1);
  };

  return (
    <div className="app-container">
      {vaultName ? (
        <>
          <div className="main-layout">
            <div className="content-wrap">
              <Sidebar
                onFileSelect={handleFileSelect}
                onTasksClick={() => setViewMode('tasks')}
                onEditorClick={() => setViewMode('editor')}
                activeFile={currentFile}
                isDirty={isDirty}
                refreshSignal={filesVersion}
                viewMode={viewMode}
              />
              <main className="main-content">
                <div className="editor-header">
                  <h1 className="editor-title">{getTitleFromContent(content, currentFile)}</h1>
                  <button
                    className="relationships-toggle"
                    onClick={() => setShowRelationshipsSidebar(!showRelationshipsSidebar)}
                    title="Toggle relationships panel"
                  >
                    🔗
                  </button>
                </div>
                {conflict && (
                  <div className="conflict-banner">
                    ⚠️ File changed on disk. You have unsaved changes.
                    <div>
                      <button
                        onClick={() => {
                          // Load disk version (discard local changes)
                          window.phosphor.readNote(conflict).then((diskContent) => {
                            skipSaveRef.current = true;
                            setContent(diskContent);
                            setConflict(null);
                            setIsDirty(false);
                            setTimeout(() => {
                              skipSaveRef.current = false;
                            }, 100);
                          });
                        }}
                      >
                        Load Disk Version (Discard My Changes)
                      </button>
                      <button
                        onClick={() => {
                          // Save local version (overwrite disk)
                          if (currentFile) {
                            window.phosphor.saveNote(currentFile, content);
                            setConflict(null);
                            setIsDirty(false);
                          }
                        }}
                      >
                        Overwrite Disk (Keep My Changes)
                      </button>
                    </div>
                  </div>
                )}
                {viewMode === 'editor' ? (
                  <>
                    <Editor
                      initialDoc={content}
                      onChange={handleContentChange}
                      onLinkClick={handleLinkClick}
                    />
                  </>
                ) : (
                  <>
                    <TasksView
                      onTaskClick={(filename, _line) => {
                        // Switch to editor view and open file
                        setViewMode('editor');
                        handleFileSelect(filename);
                        // Scroll to line after a brief delay to ensure file is loaded
                        setTimeout(() => {
                          const view = document.querySelector('.cm-editor');
                          if (view) {
                            view.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }
                        }, 100);
                      }}
                    />
                  </>
                )}
              </main>
            </div>

            {showRelationshipsSidebar && (
              <RelationshipsPanel
                currentFile={currentFile}
                graph={graph}
                backlinks={backlinks}
                onFileSelect={handleFileSelect}
              />
            )}
          </div>

          <div className="app-footer">
            <StatusBar status={status} />
          </div>

          <CommandPalette
            isOpen={commandPaletteOpen}
            onClose={() => setCommandPaletteOpen(false)}
            onSelect={handleFileSelect}
          />

          <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </>
      ) : (
        <div className="welcome-screen">
          <h1>Select a Phosphor Vault to begin.</h1>
        </div>
      )}
    </div>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SettingsProvider>
      <AppContent />
    </SettingsProvider>
  );
}

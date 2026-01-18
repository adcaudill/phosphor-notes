import React, { useState, useEffect, useRef, useMemo } from 'react';
import 'material-symbols';
import { Editor, type EditorHandle } from './components/Editor';
import EditorHeader from './components/EditorHeader';
import { Sidebar } from './components/Sidebar';
import StatusBar from './components/StatusBar';
import { InformationPanel } from './components/InformationPanel';
import { CommandPalette } from './components/CommandPalette';
import { SettingsModal } from './components/SettingsModal';
import { FrontmatterModal } from './components/FrontmatterModal';
import DailyNav from './components/DailyNav';
import { TasksView } from './components/TasksView';
import { EncryptionModal } from './components/EncryptionModal';
import { AboutModal } from './components/AboutModal';
import { GraphView } from './components/GraphView';
import { SettingsProvider } from './contexts/SettingsContext';
import { useSettings } from './hooks/useSettings';
import { extractFrontmatter, generateDefaultFrontmatter } from './utils/frontmatterUtils';

/**
 * Extract title from markdown frontmatter, or fallback to filename
 */
function getTitleFromContent(content: string, filename: string | null): string {
  if (!filename) return 'No file selected';

  // Try to extract title from frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const titleMatch = frontmatter.match(/title:\s*["']?([^"'\n]+)["']?/);
    if (titleMatch) {
      return titleMatch[1].trim();
    }
  }

  // Fallback to filename without extension
  return filename.replace(/\.md$/, '');
}

function AppContent(): React.JSX.Element {
  const { settings, updateSetting } = useSettings();
  const [content, setContent] = useState('');
  const [vaultName, setVaultName] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [fileHistory, setFileHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [filesVersion, setFilesVersion] = useState<number>(0);
  const debounceTimer = useRef<number | null>(null);
  const [graph, setGraph] = useState<Record<string, string[]>>({});
  const [backlinks, setBacklinks] = useState<Record<string, string[]>>({});
  const skipSaveRef = useRef<boolean>(false);
  const [status, setStatus] = useState<{ type: string; message: string } | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false); // Toggle for about modal
  const [conflict, setConflict] = useState<string | null>(null); // Filename that has a conflict
  const [isDirty, setIsDirty] = useState(false); // Whether current file has unsaved changes
  const [viewMode, setViewMode] = useState<'editor' | 'tasks' | 'graph'>('editor'); // Switch between editor, tasks, and graph views
  const [showInformationSidebar, setShowInformationSidebar] = useState(false); // Toggle for information sidebar
  const [frontmatterModalOpen, setFrontmatterModalOpen] = useState(false); // Toggle for frontmatter modal
  const [focusMode, setFocusMode] = useState(false); // Toggle for focus/zen mode
  const [paragraphDimming, setParagraphDimming] = useState(settings.enableParagraphDimming); // Toggle for paragraph dimming
  const [titleEditMode, setTitleEditMode] = useState(false); // Toggle for editing title
  const [editingTitle, setEditingTitle] = useState(''); // The title being edited
  const [encryptionModalOpen, setEncryptionModalOpen] = useState(false); // Encryption modal visibility
  const [encryptionMode, setEncryptionMode] = useState<'unlock' | 'create'>('unlock'); // Whether we're unlocking or creating
  const [encryptionError, setEncryptionError] = useState<string | null>(null); // Error message for encryption
  const [encryptionLoading, setEncryptionLoading] = useState(false); // Loading state for encryption operations
  const [isVaultEncrypted, setIsVaultEncrypted] = useState(false); // Whether current vault is encrypted
  const [isVaultUnlocked, setIsVaultUnlocked] = useState(false); // Whether vault is unlocked (only relevant if encrypted)
  const editorRef = useRef<EditorHandle>(null);
  const wikiPageSuggestions = useMemo(() => {
    const unique = new Set<string>();
    Object.keys(graph).forEach((filename) => {
      unique.add(filename.replace(/\.md$/, ''));
    });
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [graph]);

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

  // Sync feature toggles with settings
  useEffect(() => {
    setParagraphDimming(settings.enableParagraphDimming);
  }, [settings.enableParagraphDimming]);

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

        // Check if vault is encrypted
        try {
          const isEncrypted = await window.phosphor.isEncryptionEnabled?.();
          setIsVaultEncrypted(!!isEncrypted);

          if (isEncrypted) {
            // Check if already unlocked
            const isUnlocked = await window.phosphor.isVaultUnlocked?.();
            setIsVaultUnlocked(!!isUnlocked);

            if (!isUnlocked) {
              // Show unlock modal
              setEncryptionMode('unlock');
              setEncryptionModalOpen(true);
              return; // Don't load content yet
            }
          }
        } catch (err) {
          console.warn('Failed to check encryption status:', err);
        }

        // Load the vault content
        await loadVaultContent();
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

    const unsubscribeFocusMode = window.phosphor.onMenuEvent?.('menu:focus-mode', () => {
      setFocusMode((prev) => !prev);
    });

    const unsubscribeDimming = window.phosphor.onMenuEvent?.('menu:paragraph-dimming', () => {
      setParagraphDimming((prev) => {
        const newValue = !prev;
        updateSetting('enableParagraphDimming', newValue);
        return newValue;
      });
    });

    const unsubscribePreferences = window.phosphor.onMenuEvent?.('menu:preferences', () => {
      setSettingsOpen(true);
    });

    const unsubscribeAbout = window.phosphor.onMenuEvent?.('menu:about', () => {
      setAboutModalOpen(true);
    });

    const unsubscribeEnableEncryption = window.phosphor.onMenuEvent?.(
      'menu:enable-encryption',
      () => {
        setEncryptionMode('create');
        setEncryptionModalOpen(true);
      }
    );

    const unsubscribeLockVault = window.phosphor.onMenuEvent?.('menu:lock-vault', async () => {
      try {
        await window.phosphor.lockVault?.();
        setIsVaultUnlocked(false);
        // Show unlock modal again on next use
        setEncryptionMode('unlock');
        setEncryptionModalOpen(true);
      } catch (err) {
        console.error('Failed to lock vault:', err);
      }
    });

    const unsubscribeImportLogseq = window.phosphor.onMenuEvent?.(
      'menu:import-logseq',
      async () => {
        try {
          const result = await window.phosphor.importLogseq?.();
          if (result && typeof result === 'object' && 'success' in result && result.success) {
            // Import succeeded, vault will be re-indexed automatically
            console.log('Logseq import completed');
          }
        } catch (err) {
          console.error('Failed to import Logseq vault:', err);
        }
      }
    );

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
      if (unsubscribeFocusMode) unsubscribeFocusMode();
      if (unsubscribeDimming) unsubscribeDimming();
      if (unsubscribeFileChanged) unsubscribeFileChanged();
      if (unsubscribeFileDeleted) unsubscribeFileDeleted();
      if (unsubscribeFileAdded) unsubscribeFileAdded();
      if (unsubscribeCheckUnsaved) unsubscribeCheckUnsaved();
      if (unsubscribePreferences) unsubscribePreferences();
      if (unsubscribeAbout) unsubscribeAbout();
      if (unsubscribeEnableEncryption) unsubscribeEnableEncryption();
      if (unsubscribeLockVault) unsubscribeLockVault();
      if (unsubscribeImportLogseq) unsubscribeImportLogseq();
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  const handleContentChange = (newContent: string): void => {
    setContent(newContent); // keep UI (word count, status) aligned with editor text

    if (skipSaveRef.current) return; // skip saving when content is being programmatically loaded

    setIsDirty(true); // Mark as having unsaved changes
    if (currentFile) {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = window.setTimeout(async () => {
        if (!currentFile) return;
        try {
          await window.phosphor.saveNote(currentFile, newContent);
          setIsDirty(false); // Mark as saved
        } catch (err) {
          console.error('Failed to save note:', err);
        }
      }, 500) as unknown as number;
    }
  };

  const handleFileSelect = async (filename: string): Promise<void> => {
    try {
      console.debug('handleFileSelect invoked for', filename);
      let noteContent = await window.phosphor.readNote(filename);

      // Ensure frontmatter exists and capture mode/content
      let { frontmatter, content: contentOnly } = extractFrontmatter(noteContent);
      if (!frontmatter) {
        console.debug('File missing frontmatter, adding default:', filename);
        const defaultFrontmatter = generateDefaultFrontmatter(
          filename,
          settings.defaultJournalMode
        );
        noteContent = defaultFrontmatter + '\n' + noteContent;
        await window.phosphor.saveNote(filename, noteContent);

        // Re-extract after adding frontmatter
        const parts = extractFrontmatter(noteContent);
        frontmatter = parts.frontmatter;
        contentOnly = parts.content;
      }

      const isOutliner = frontmatter?.content?.mode === 'outliner';

      // If outliner mode and content is empty, seed with a bullet
      if (isOutliner && contentOnly.trim() === '') {
        noteContent = `${frontmatter?.raw ?? ''}\n- `;
        await window.phosphor.saveNote(filename, noteContent);
      }

      // Prevent the programmatic content load from triggering a save
      skipSaveRef.current = true;
      setContent(noteContent);
      setCurrentFile(filename);
      // Update navigation history - avoid duplicate consecutive entries
      setFileHistory((prev) => {
        const last = prev[historyIndex] ?? null;
        if (last === filename) return prev;
        const newHist = prev.slice(0, historyIndex + 1).concat(filename);
        setHistoryIndex(newHist.length - 1);
        return newHist;
      });
      setConflict(null); // Clear conflict if switching files
      setIsDirty(false); // New file is not dirty
      // Update MRU for the opened file so there's a single place
      try {
        await window.phosphor.updateMRU(filename);
      } catch (err) {
        console.debug('Failed to update MRU:', err);
      }
      // Bump filesVersion so Sidebar re-fetches MRU
      setFilesVersion((v) => v + 1);
      // Allow saves after the debounce window
      setTimeout(() => {
        skipSaveRef.current = false;
      }, 600);
    } catch (err) {
      console.error('Failed to read note', filename, err);
    }
  };

  /** Load a file from history index without mutating the history stack */
  const loadFileAtHistoryIndex = async (idx: number): Promise<void> => {
    if (idx < 0 || idx >= fileHistory.length) return;
    const filename = fileHistory[idx];
    try {
      skipSaveRef.current = true;
      const noteContent = await window.phosphor.readNote(filename);
      setContent(noteContent);
      setCurrentFile(filename);
      setConflict(null);
      setIsDirty(false);
      setHistoryIndex(idx);
      // Bump filesVersion so Sidebar re-fetches MRU
      setFilesVersion((v) => v + 1);
      setTimeout(() => {
        skipSaveRef.current = false;
      }, 600);
    } catch (err) {
      console.error('Failed to load history file', filename, err);
    }
  };

  const navigateBack = async (): Promise<void> => {
    if (historyIndex > 0) {
      await loadFileAtHistoryIndex(historyIndex - 1);
    }
  };

  const navigateForward = async (): Promise<void> => {
    if (historyIndex < fileHistory.length - 1) {
      await loadFileAtHistoryIndex(historyIndex + 1);
    }
  };

  /**
   * Load vault content (daily note, files, graph)
   */
  const loadVaultContent = async (): Promise<void> => {
    try {
      const dailyNoteFilename = await window.phosphor.getDailyNoteFilename();
      setCurrentFile(dailyNoteFilename);
      let noteContent = await window.phosphor.readNote(dailyNoteFilename);

      // Ensure frontmatter exists and capture mode/content
      let { frontmatter, content: contentOnly } = extractFrontmatter(noteContent);
      if (!frontmatter) {
        const defaultFrontmatter = generateDefaultFrontmatter(
          dailyNoteFilename,
          settings.defaultJournalMode
        );
        noteContent = defaultFrontmatter + '\n' + noteContent;
        await window.phosphor.saveNote(dailyNoteFilename, noteContent);

        const parts = extractFrontmatter(noteContent);
        frontmatter = parts.frontmatter;
        contentOnly = parts.content;
      }

      const isOutliner = frontmatter?.content?.mode === 'outliner';

      // Seed empty outliner daily notes with a single bullet
      if (isOutliner && contentOnly.trim() === '') {
        noteContent = `${frontmatter?.raw ?? ''}\n- `;
        await window.phosphor.saveNote(dailyNoteFilename, noteContent);
      }

      setContent(noteContent);
      try {
        await window.phosphor.updateMRU(dailyNoteFilename);
      } catch (err) {
        console.debug('Failed to update MRU:', err);
      }
      // Initialize navigation history with the daily note on first load
      setFileHistory((prev) => {
        if (prev.length === 0 || historyIndex === -1) {
          setHistoryIndex(0);
          return [dailyNoteFilename];
        }
        return prev;
      });
    } catch (err) {
      console.error('Failed to load vault content:', err);
    }
  };

  /**
   * Handle header mouse down for window dragging
   * (Double-click is handled via onDoubleClick on the title element)
   */
  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Don't interfere with interactive elements
    const target = e.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('.editor-header-actions')
    ) {
      return;
    }
  };

  /**
   * Handle double-click on title to enable edit mode
   */
  const handleTitleDoubleClick = (e: React.MouseEvent<HTMLHeadingElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    if (viewMode === 'editor' && currentFile) {
      const currentTitle = getTitleFromContent(content, currentFile);
      setEditingTitle(currentTitle);
      setTitleEditMode(true);
    }
  };

  /**
   * Save the edited title to frontmatter and update the file
   */
  const handleTitleSave = async (newTitle: string): Promise<void> => {
    if (!currentFile || !newTitle.trim()) {
      setTitleEditMode(false);
      return;
    }

    const trimmedTitle = newTitle.trim();

    // Update frontmatter with new title
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let updatedContent = content;

    if (frontmatterMatch) {
      let frontmatter = frontmatterMatch[1];
      // Replace existing title or add new one
      if (frontmatter.includes('title:')) {
        frontmatter = frontmatter.replace(
          /title:\s*["']?[^"'\n]+["']?/,
          `title: "${trimmedTitle}"`
        );
      } else {
        frontmatter = `title: "${trimmedTitle}"\n${frontmatter}`;
      }
      updatedContent = `---\n${frontmatter}\n---${content.slice(frontmatterMatch[0].length)}`;
    }

    // Save the updated content
    try {
      await window.phosphor.saveNote(currentFile, updatedContent);
      setContent(updatedContent);
      setIsDirty(false);
    } catch (err) {
      console.error('Failed to save title:', err);
    }

    setTitleEditMode(false);
  };

  /**
   * Handle keyboard events in title input
   */
  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleTitleSave(editingTitle);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTitleEditMode(false);
    }
  };

  /**
   * Handle encryption modal submission (unlock or create)
   */
  const handleEncryptionSubmit = async (password: string): Promise<void> => {
    setEncryptionLoading(true);
    setEncryptionError(null);

    try {
      if (encryptionMode === 'unlock') {
        // Try to unlock the vault
        const success = await window.phosphor.unlockVault?.(password);
        if (success) {
          setIsVaultUnlocked(true);
          setEncryptionModalOpen(false);
          // Load content after unlocking
          await loadVaultContent();
        } else {
          setEncryptionError('Invalid password');
        }
      } else {
        // Create encryption for the vault
        const success = await window.phosphor.createEncryption?.(password);
        if (success) {
          setIsVaultEncrypted(true);
          setIsVaultUnlocked(true);
          setEncryptionModalOpen(false);
          // Load content after creating encryption
          await loadVaultContent();
        } else {
          setEncryptionError('Failed to create encryption');
        }
      }
    } catch (err) {
      console.error('Encryption operation failed:', err);
      setEncryptionError(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setEncryptionLoading(false);
    }
  };

  /**
   * Handle encryption modal cancel
   */
  const handleEncryptionCancel = (): void => {
    // If vault is encrypted and not unlocked, user can't proceed
    if (isVaultEncrypted && !isVaultUnlocked) {
      // Don't allow closing the modal - force unlock or exit
      return;
    }
    setEncryptionModalOpen(false);
    setEncryptionError(null);
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
    // Update navigation history so wikilink opens are recorded
    setFileHistory((prev) => {
      const last = prev[historyIndex] ?? null;
      if (last === filename) return prev;
      const newHist = prev.slice(0, historyIndex + 1).concat(filename);
      setHistoryIndex(newHist.length - 1);
      return newHist;
    });
    // Trigger a save to ensure it appears in sidebar immediately
    await window.phosphor.saveNote(filename, content);
    // Update MRU when wikilink is clicked
    try {
      await window.phosphor.updateMRU(filename);
    } catch (err) {
      console.debug('Failed to update MRU:', err);
    }
    // Bump filesVersion so Sidebar re-fetches
    setFilesVersion((v) => v + 1);
  };

  /**
   * Handle header click from Information Panel to scroll to that line
   */
  const handleHeaderClick = (lineNumber: number): void => {
    if (editorRef.current?.scrollToLine) {
      editorRef.current.scrollToLine(lineNumber);
    }
  };

  return (
    <div className="app-container">
      {vaultName ? (
        <>
          <div className={`main-layout ${focusMode ? 'focus-mode' : ''}`}>
            <div className="content-wrap">
              <Sidebar
                onFileSelect={handleFileSelect}
                onTasksClick={() => setViewMode('tasks')}
                onEditorClick={() => setViewMode('editor')}
                onGraphClick={() => setViewMode('graph')}
                activeFile={currentFile}
                isDirty={isDirty}
                refreshSignal={filesVersion}
                viewMode={viewMode}
              />
              <main className="main-content">
                <EditorHeader
                  handleHeaderMouseDown={handleHeaderMouseDown}
                  viewMode={viewMode}
                  titleEditMode={titleEditMode}
                  editingTitle={editingTitle}
                  onEditingTitleChange={setEditingTitle}
                  onTitleSave={handleTitleSave}
                  onTitleKeyDown={handleTitleKeyDown}
                  onTitleDoubleClick={handleTitleDoubleClick}
                  onOpenFrontmatter={() => setFrontmatterModalOpen(true)}
                  onToggleInformationSidebar={() =>
                    setShowInformationSidebar(!showInformationSidebar)
                  }
                  currentTitle={
                    viewMode === 'tasks'
                      ? 'Tasks'
                      : viewMode === 'graph'
                        ? 'Graph'
                        : getTitleFromContent(content, currentFile)
                  }
                  onNavigateBack={navigateBack}
                  onNavigateForward={navigateForward}
                  canGoBack={historyIndex > 0}
                  canGoForward={historyIndex < fileHistory.length - 1}
                  onOpenFile={handleFileSelect}
                />
                {viewMode === 'editor' && (
                  <DailyNav
                    currentFile={currentFile}
                    content={content}
                    onOpenFile={handleFileSelect}
                  />
                )}
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
                      ref={editorRef}
                      initialDoc={content}
                      onChange={handleContentChange}
                      onLinkClick={handleLinkClick}
                      enableDimming={paragraphDimming}
                      currentFile={currentFile}
                      wikiPageSuggestions={wikiPageSuggestions}
                    />
                  </>
                ) : (
                  <>
                    {viewMode === 'tasks' ? (
                      <TasksView
                        onTaskClick={(filename) => {
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
                    ) : (
                      <GraphView
                        graph={graph}
                        onFileSelect={(filename) => {
                          setViewMode('editor');
                          handleFileSelect(filename);
                        }}
                      />
                    )}
                  </>
                )}
              </main>
            </div>

            {showInformationSidebar && (
              <InformationPanel
                key={currentFile ?? 'no-file'}
                currentFile={currentFile}
                content={content}
                graph={graph}
                backlinks={backlinks}
                onFileSelect={handleFileSelect}
                onHeaderClick={handleHeaderClick}
              />
            )}
          </div>

          <div className="app-footer">
            <StatusBar
              status={status}
              content={viewMode === 'editor' ? content : undefined}
              isVaultEncrypted={isVaultEncrypted}
              isVaultUnlocked={isVaultUnlocked}
            />
          </div>

          <CommandPalette
            isOpen={commandPaletteOpen}
            onClose={() => setCommandPaletteOpen(false)}
            onSelect={handleFileSelect}
          />

          <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <FrontmatterModal
            isOpen={frontmatterModalOpen}
            onClose={() => setFrontmatterModalOpen(false)}
            currentFile={currentFile}
            content={content}
            onSave={(updatedContent) => {
              setContent(updatedContent);
              if (currentFile) {
                window.phosphor.saveNote(currentFile, updatedContent);
              }
            }}
            onDelete={(filename) => {
              window.phosphor.deleteNote(filename);
              setCurrentFile(null);
              setContent('');
              setFilesVersion((v) => v + 1);
            }}
          />

          <EncryptionModal
            isOpen={encryptionModalOpen}
            mode={encryptionMode}
            onSubmit={handleEncryptionSubmit}
            onCancel={handleEncryptionCancel}
            isLoading={encryptionLoading}
            error={encryptionError || undefined}
          />

          <AboutModal isOpen={aboutModalOpen} onClose={() => setAboutModalOpen(false)} />
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

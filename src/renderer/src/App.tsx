import React, { useState, useEffect, useRef } from 'react';
import { Editor } from './components/Editor';
import { Sidebar } from './components/Sidebar';
import StatusBar from './components/StatusBar';

declare global {
  interface Window {
    phosphor: {
      selectVault: () => Promise<string | null>;
      getCurrentVault?: () => Promise<string | null>;
      getCachedGraph?: () => Promise<Record<string, string[]> | null>;
      getDailyNoteFilename: () => Promise<string>;
      readNote: (filename: string) => Promise<string>;
      saveNote: (filename: string, content: string) => Promise<void>;
      onGraphUpdate: (cb: (graph: Record<string, string[]>) => void) => (() => void) | void;
      onStatusUpdate: (
        cb: (s: { type: string; message: string } | null) => void
      ) => (() => void) | void;
    };
  }
}

function App(): React.JSX.Element {
  const [content, setContent] = useState('');
  const [vaultName, setVaultName] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [filesVersion, setFilesVersion] = useState<number>(0);
  const debounceTimer = useRef<number | null>(null);
  const [backlinks, setBacklinks] = useState<Record<string, string[]>>({});
  const skipSaveRef = useRef<boolean>(false);
  const [status, setStatus] = useState<{ type: string; message: string } | null>(null);
  const statusTimerRef = useRef<number | null>(null);

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
    const unsubscribe = window.phosphor.onGraphUpdate((graph) => {
      console.debug('Received graph update, raw keys:', Object.keys(graph).length, graph);
      const bl: Record<string, string[]> = {};
      Object.entries(graph).forEach(([source, links]) => {
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

    return () => {
      if (unsubscribe) unsubscribe();
      if (unsubscribeStatus) unsubscribeStatus();
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  const handleContentChange = (newContent: string): void => {
    setContent(newContent);
    if (skipSaveRef.current) return; // skip saving when content is being programmatically loaded
    if (currentFile) {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = window.setTimeout(() => {
        if (currentFile) {
          window.phosphor.saveNote(currentFile, newContent);
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
          <div className="content-wrap">
            <Sidebar
              onFileSelect={handleFileSelect}
              activeFile={currentFile}
              refreshSignal={filesVersion}
            />
            <main className="main-content">
              <Editor
                initialDoc={content}
                onChange={handleContentChange}
                onLinkClick={handleLinkClick}
              />
            </main>
          </div>

          <div className="app-footer">
            <div className="linked-footer">
              {currentFile ? (
                <div>
                  <strong>Linked from:</strong>{' '}
                  {(backlinks[currentFile] || []).length === 0 ? (
                    <em>None</em>
                  ) : (
                    (backlinks[currentFile] || []).map((f, i) => (
                      <button
                        key={f}
                        style={{ marginLeft: i ? 8 : 6 }}
                        onClick={() => handleFileSelect(f)}
                      >
                        {f}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <StatusBar status={status} />
          </div>
        </>
      ) : (
        <div className="welcome-screen">
          <h1>Select a Phosphor Vault to begin.</h1>
        </div>
      )}
    </div>
  );
}

export default App;

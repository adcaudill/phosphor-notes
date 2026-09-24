import React, { useState, useEffect, useMemo, useRef } from 'react';

interface SearchResult {
  id: string;
  title: string;
  filename: string;
  snippet?: string;
}

interface CommandEntry {
  type: 'command';
  id: string;
  title: string;
  snippet: string;
}

interface FileEntry extends SearchResult {
  type: 'file';
}

type PaletteEntry = CommandEntry | FileEntry;

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (filename: string) => void;
  /** Static app commands (Open Tasks View, etc.) - kept as a minimal addition to file search rather than redesigning this into a full two-mode palette. */
  onCommand?: (commandId: string) => void;
}

const STATIC_COMMANDS: Omit<CommandEntry, 'type'>[] = [
  { id: 'open-tasks', title: 'Open Tasks View', snippet: 'Switch to the Tasks view' },
  { id: 'open-graph', title: 'Open Graph View', snippet: 'Switch to the Graph view' },
  { id: 'new-task', title: 'New Task', snippet: "Add a task to today's daily note" }
];

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSelect,
  onCommand
}) => {
  const [query, setQuery] = useState('');
  const [fileResults, setFileResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<number | null>(null);
  const resultItemsRef = useRef<(HTMLLIElement | null)[]>([]);

  // 1. Focus input when opened and reset state
  useEffect(() => {
    if (isOpen) {
      // Use queueMicrotask to defer state updates and avoid cascading renders
      queueMicrotask(() => {
        setQuery('');
        setFileResults([]);
        setSelectedIndex(0);
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  const matchingCommands = useMemo((): CommandEntry[] => {
    if (!onCommand) return [];
    const q = query.trim().toLowerCase();
    return STATIC_COMMANDS.filter((c) => !q || c.title.toLowerCase().includes(q)).map((c) => ({
      ...c,
      type: 'command' as const
    }));
  }, [query, onCommand]);

  const results: PaletteEntry[] = [
    ...matchingCommands,
    ...fileResults.map((r): FileEntry => ({ ...r, type: 'file' }))
  ];

  // Commands recompute synchronously on every keystroke, so reset selection
  // immediately rather than waiting for the debounced file search below.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 2. Handle Typing (Search)
  useEffect(() => {
    if (!query) {
      queueMicrotask(() => {
        setFileResults([]);
      });
      return;
    }

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = window.setTimeout(async () => {
      try {
        const hits = await window.phosphor.search(query);
        setFileResults(hits || []);
      } catch (err) {
        console.error('Search failed:', err);
        setFileResults([]);
      }
    }, 150);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [query]);

  // 3. Auto-scroll selected item into view
  useEffect(() => {
    if (resultItemsRef.current[selectedIndex]) {
      resultItemsRef.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      });
    }
  }, [selectedIndex]);

  const activate = (entry: PaletteEntry): void => {
    if (entry.type === 'command') {
      onCommand?.(entry.id);
    } else {
      onSelect(entry.filename);
    }
    onClose();
  };

  // 4. Handle Keyboard Navigation
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        activate(results[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search files or type a command..."
          className="command-palette-search-input"
        />
        <ul className="result-list">
          {results.map((entry, i) => (
            <li
              ref={(el) => {
                resultItemsRef.current[i] = el;
              }}
              key={entry.type === 'command' ? `cmd-${entry.id}` : entry.id}
              className={i === selectedIndex ? 'result-item selected' : 'result-item'}
              onClick={() => activate(entry)}
            >
              <div className="result-title">
                {entry.type === 'command' && (
                  <span className="material-symbols-outlined result-command-icon">bolt</span>
                )}
                {entry.title}
              </div>
              {entry.snippet && <div className="result-snippet">{entry.snippet}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

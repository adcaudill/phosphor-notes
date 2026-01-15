import React, { useState, useEffect, useRef } from 'react';
import { SearchResult } from '../../../types/phosphor';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (filename: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, onSelect }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<number | null>(null);

  // 1. Focus input when opened and reset state
  useEffect(() => {
    if (isOpen) {
      // Use queueMicrotask to defer state updates and avoid cascading renders
      queueMicrotask(() => {
        setQuery('');
        setResults([]);
        setSelectedIndex(0);
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // 2. Handle Typing (Search)
  useEffect(() => {
    if (!query) {
      // Defer clearing results to avoid cascading renders
      queueMicrotask(() => {
        setResults([]);
      });
      return;
    }

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = window.setTimeout(async () => {
      try {
        const hits = await window.phosphor.search(query);
        setResults(hits || []);
        setSelectedIndex(0);
      } catch (err) {
        console.error('Search failed:', err);
        setResults([]);
      }
    }, 150);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [query]);

  // 3. Handle Keyboard Navigation
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
        const filename = results[selectedIndex].filename;
        // Update MRU when file is selected from command palette
        window.phosphor.updateMRU(filename).catch((err) => {
          console.debug('Failed to update MRU:', err);
        });
        onSelect(filename);
        onClose();
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
          placeholder="Search files..."
          className="command-palette-search-input"
        />
        <ul className="result-list">
          {results &&
            results.map((res, i) => (
              <li
                key={res.id}
                className={i === selectedIndex ? 'result-item selected' : 'result-item'}
                onClick={() => {
                  // Update MRU when file is selected from command palette
                  window.phosphor.updateMRU(res.filename).catch((err) => {
                    console.debug('Failed to update MRU:', err);
                  });
                  onSelect(res.filename);
                  onClose();
                }}
              >
                <div className="result-title">{res.title}</div>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
};

import React, { useState, useEffect, useRef } from 'react';
import { SearchAPI } from '../editor/extensions/search';
import '../styles/SearchPanel.css';

interface SearchPanelProps {
  searchAPI: SearchAPI | null;
  onClose: () => void;
}

interface MatchCount {
  current: number;
  total: number;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ searchAPI, onClose }) => {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [matchCount, setMatchCount] = useState<MatchCount>({ current: 0, total: 0 });
  const queryInputRef = useRef<HTMLInputElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);

  // Focus the search input when the panel opens
  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  // Handle search query changes
  useEffect(() => {
    if (!searchAPI) return;

    searchAPI.setQuery(query, caseSensitive, wholeWord, regex);

    // Update match count after setting query
    const timer = setTimeout(() => {
      const state = searchAPI.getState();
      setMatchCount({
        current: query ? state.index + 1 : 0,
        total: query ? state.total : 0
      });
    }, 0);

    return () => clearTimeout(timer);
  }, [query, caseSensitive, wholeWord, regex, searchAPI]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        handlePrevMatch();
      } else {
        handleNextMatch();
      }
    }
  };

  const handleReplacementKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      handleReplaceAll();
    } else if (e.key === 'Enter') {
      handleReplace();
    }
  };

  const handleNextMatch = (): void => {
    if (searchAPI) {
      searchAPI.nextMatch();
      const state = searchAPI.getState();
      setMatchCount({
        current: state.index + 1,
        total: state.total
      });
    }
  };

  const handlePrevMatch = (): void => {
    if (searchAPI) {
      searchAPI.prevMatch();
      const state = searchAPI.getState();
      setMatchCount({
        current: state.index + 1,
        total: state.total
      });
    }
  };

  const handleReplace = (): void => {
    if (searchAPI && query) {
      searchAPI.replaceSelection(replacement);
      handleNextMatch();
    }
  };

  const handleReplaceAll = (): void => {
    if (searchAPI && query) {
      searchAPI.replaceAll(replacement);
      setQuery('');
      setReplacement('');
    }
  };

  return (
    <div className="search-panel">
      <div className="search-container">
        {/* Search input section */}
        <div className="search-input-group">
          <input
            ref={queryInputRef}
            type="text"
            placeholder="Find..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="search-input"
            aria-label="Search query"
          />
          <div className="search-controls">
            <button
              onClick={() => setRegex(!regex)}
              className={`search-button ${regex ? 'active' : ''}`}
              title="Regular expression"
              aria-pressed={regex}
            >
              .*
            </button>
            <button
              onClick={() => setCaseSensitive(!caseSensitive)}
              className={`search-button ${caseSensitive ? 'active' : ''}`}
              title="Case sensitive"
              aria-pressed={caseSensitive}
            >
              Aa
            </button>
            <button
              onClick={() => setWholeWord(!wholeWord)}
              className={`search-button ${wholeWord ? 'active' : ''}`}
              title="Whole word"
              aria-pressed={wholeWord}
            >
              Ab
            </button>
          </div>
          <div className="match-count">
            {query && (
              <span>
                {matchCount.total > 0 ? `${matchCount.current}/${matchCount.total}` : 'No matches'}
              </span>
            )}
          </div>
          <button
            onClick={() => handlePrevMatch()}
            className="nav-button"
            title="Previous match (Shift+Enter)"
            disabled={matchCount.total === 0}
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            onClick={() => handleNextMatch()}
            className="nav-button"
            title="Next match (Enter)"
            disabled={matchCount.total === 0}
            aria-label="Next match"
          >
            ↓
          </button>
          <button
            onClick={onClose}
            className="close-button"
            title="Close search (Escape)"
            aria-label="Close search"
          >
            ✕
          </button>
        </div>

        {/* Replace section */}
        {showReplace && (
          <div className="replace-input-group">
            <input
              ref={replacementInputRef}
              type="text"
              placeholder="Replace..."
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={handleReplacementKeyDown}
              className="search-input"
              aria-label="Replacement text"
            />
            <button
              onClick={handleReplace}
              className="replace-button"
              title="Replace current match"
              disabled={matchCount.total === 0}
              aria-label="Replace current match"
            >
              Replace
            </button>
            <button
              onClick={handleReplaceAll}
              className="replace-button"
              title="Replace all (Ctrl+Enter)"
              disabled={matchCount.total === 0}
              aria-label="Replace all matches"
            >
              Replace All
            </button>
          </div>
        )}

        {/* Toggle replace section button */}
        <button
          onClick={() => {
            setShowReplace(!showReplace);
            if (!showReplace) {
              setTimeout(() => replacementInputRef.current?.focus(), 0);
            }
          }}
          className="toggle-replace-button"
          title={showReplace ? 'Hide replace' : 'Show replace'}
          aria-expanded={showReplace}
          aria-label="Toggle replace"
        >
          {showReplace ? '▼' : '▶'} Replace
        </button>
      </div>
    </div>
  );
};

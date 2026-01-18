import React, { useMemo } from 'react';

interface DocumentHeader {
  level: number; // 1-6 for h1-h6
  text: string;
  lineNumber: number; // Line number in the document (1-indexed)
}

interface InformationPanelProps {
  currentFile: string | null;
  content: string;
  graph: Record<string, string[]>;
  backlinks: Record<string, string[]>;
  onFileSelect: (filename: string) => void;
  onHeaderClick?: (lineNumber: number) => void;
}

/**
 * Extract markdown headers (h1-h6) from document content
 */
function extractHeadersFromContent(content: string): DocumentHeader[] {
  const headers: DocumentHeader[] = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const headerRegex = /^(#{1,6})\s+(.+?)(?:\s*\{#[^}]+\})?$/;
    const match = line.match(headerRegex);

    if (match) {
      const level = match[1].length; // Number of # symbols (1-6)
      const text = match[2].trim();

      headers.push({
        level,
        text,
        lineNumber: index + 1 // 1-indexed line number
      });
    }
  });

  return headers;
}

export const InformationPanel: React.FC<InformationPanelProps> = ({
  currentFile,
  content,
  graph,
  backlinks,
  onFileSelect,
  onHeaderClick
}) => {
  const headers = useMemo(() => extractHeadersFromContent(content), [content]);

  const { outgoing, incoming, totalConnections } = useMemo(() => {
    if (!currentFile) {
      return { outgoing: [], incoming: [], totalConnections: 0 };
    }

    // Normalize lookup for graph/backlinks keys: some producers store filenames
    // with or without the `.md` extension. Try several variants to find matches.
    const tryLookup = (obj: Record<string, string[]>, key: string): string[] => {
      if (!obj) return [];
      if (obj[key]) return obj[key];
      const noExt = key.replace(/\.md$/i, '');
      if (obj[noExt]) return obj[noExt];
      const withExt = key.endsWith('.md') ? key : `${key}.md`;
      if (obj[withExt]) return obj[withExt];
      return [];
    };

    // Only include markdown files (.md extension)
    const out = tryLookup(graph, currentFile).filter((f) => f.endsWith('.md'));
    const inc = tryLookup(backlinks, currentFile).filter((f) => f.endsWith('.md'));
    return {
      outgoing: out,
      incoming: inc,
      totalConnections: out.length + inc.length
    };
  }, [currentFile, graph, backlinks]);

  if (!currentFile) {
    return null;
  }

  const hasConnections = totalConnections > 0;
  const hasHeaders = headers.length > 0;

  return (
    <div className="information-panel">
      {/* Document Outline Section */}
      {hasHeaders && (
        <div className="information-section outline-section">
          <div className="information-section-header">
            <span className="information-section-title">Document Outline</span>
            <span className="information-section-count">
              {headers.length} section{headers.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="outline-items">
            {headers.map((header) => (
              <button
                key={`${header.lineNumber}-${header.text}`}
                className={`outline-item outline-level-${header.level}`}
                onClick={() => {
                  if (onHeaderClick) {
                    onHeaderClick(header.lineNumber);
                  }
                }}
                title={header.text}
                style={{
                  paddingLeft: `${(header.level - 1) * 0.75}rem`
                }}
              >
                <span className="outline-item-text">{header.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Document Relationships Section */}
      <div className="information-section">
        <div className="information-section-header">
          <span className="information-section-title">Document Relationships</span>
          <span className="information-section-count">
            {totalConnections} connection{totalConnections !== 1 ? 's' : ''}
          </span>
        </div>

        {!hasConnections ? (
          <div className="information-empty">
            <em>No connections</em>
          </div>
        ) : (
          <div className="information-content">
            {/* Incoming Links (Backlinks) */}
            {incoming.length > 0 && (
              <div className="information-group">
                <div className="information-group-header">
                  <span className="information-group-title">Linked from ({incoming.length})</span>
                </div>
                <div className="information-group-items">
                  {incoming.map((file) => (
                    <button
                      key={file}
                      className="information-item incoming"
                      onClick={() => onFileSelect(file)}
                      title={file}
                    >
                      <span className="information-item-icon">←</span>
                      <span className="information-item-name">{file}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Outgoing Links */}
            {outgoing.length > 0 && (
              <div className="information-group">
                <div className="information-group-header">
                  <span className="information-group-title">Links to ({outgoing.length})</span>
                </div>
                <div className="information-group-items">
                  {outgoing.map((file) => (
                    <button
                      key={file}
                      className="information-item outgoing"
                      onClick={() => onFileSelect(file)}
                      title={file}
                    >
                      <span className="information-item-name">{file}</span>
                      <span className="information-item-icon">→</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

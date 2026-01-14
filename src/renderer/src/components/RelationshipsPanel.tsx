import React, { useMemo } from 'react';

interface RelationshipsPanelProps {
  currentFile: string | null;
  graph: Record<string, string[]>;
  backlinks: Record<string, string[]>;
  onFileSelect: (filename: string) => void;
}

export const RelationshipsPanel: React.FC<RelationshipsPanelProps> = ({
  currentFile,
  graph,
  backlinks,
  onFileSelect
}) => {
  const { outgoing, incoming, totalConnections } = useMemo(() => {
    if (!currentFile) {
      return { outgoing: [], incoming: [], totalConnections: 0 };
    }

    // Only include markdown files (.md extension)
    const out = (graph[currentFile] || []).filter((f) => f.endsWith('.md'));
    const inc = (backlinks[currentFile] || []).filter((f) => f.endsWith('.md'));
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

  return (
    <div className="relationships-panel">
      <div className="relationships-header">
        <span className="relationships-title">Document Relationships</span>
        <span className="relationships-count">
          {totalConnections} connection{totalConnections !== 1 ? 's' : ''}
        </span>
      </div>

      {!hasConnections ? (
        <div className="relationships-empty">
          <em>No connections</em>
        </div>
      ) : (
        <div className="relationships-content">
          {/* Incoming Links (Backlinks) */}
          {incoming.length > 0 && (
            <div className="relationship-group">
              <div className="relationship-group-header">
                <span className="relationship-group-title">Linked from ({incoming.length})</span>
              </div>
              <div className="relationship-group-items">
                {incoming.map((file) => (
                  <button
                    key={file}
                    className="relationship-item incoming"
                    onClick={() => {
                      window.phosphor.updateMRU(file).catch((err) => {
                        console.debug('Failed to update MRU:', err);
                      });
                      onFileSelect(file);
                    }}
                    title={file}
                  >
                    <span className="relationship-item-icon">←</span>
                    <span className="relationship-item-name">{file}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Outgoing Links */}
          {outgoing.length > 0 && (
            <div className="relationship-group">
              <div className="relationship-group-header">
                <span className="relationship-group-title">Links to ({outgoing.length})</span>
              </div>
              <div className="relationship-group-items">
                {outgoing.map((file) => (
                  <button
                    key={file}
                    className="relationship-item outgoing"
                    onClick={() => {
                      window.phosphor.updateMRU(file).catch((err) => {
                        console.debug('Failed to update MRU:', err);
                      });
                      onFileSelect(file);
                    }}
                    title={file}
                  >
                    <span className="relationship-item-name">{file}</span>
                    <span className="relationship-item-icon">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

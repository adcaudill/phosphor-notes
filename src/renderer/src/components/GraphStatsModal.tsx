import React, { useState, useEffect } from 'react';
import '../styles/GraphStatsModal.css';

interface GraphStats {
  totalFiles: number;
  totalLinks: number;
  avgLinksPerFile: number;
  isolatedFiles: number;
  cycles: number;
  mostLinked: { file: string; backlinks: number }[];
}

interface GraphStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const GraphStatsModal: React.FC<GraphStatsModalProps> = ({ isOpen, onClose }) => {
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !stats && !loading) {
      const fetchStats = async (): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
          const graphStats = await window.phosphor.getGraphStats?.();
          if (graphStats) {
            setStats(graphStats);
          }
        } catch (err) {
          setError('Failed to load graph statistics');
          console.error('Failed to load graph stats:', err);
        } finally {
          setLoading(false);
        }
      };

      fetchStats();
    }
  }, [isOpen, stats, loading]);

  if (!isOpen) return null;

  return (
    <div className="graph-stats-modal-overlay" onClick={onClose}>
      <div className="graph-stats-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="graph-stats-header">
          <h1>Graph Information</h1>
          <button className="graph-stats-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="graph-stats-body">
          {loading && <div className="loading-message">Loading graph statistics...</div>}
          {error && <div className="error-message">{error}</div>}
          {stats && !loading && (
            <>
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-label">Total Files</div>
                  <div className="stat-value">{stats.totalFiles}</div>
                  <div className="stat-description">notes in your vault</div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">Total Links</div>
                  <div className="stat-value">{stats.totalLinks}</div>
                  <div className="stat-description">wiki links created</div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">Avg Links per File</div>
                  <div className="stat-value">{stats.avgLinksPerFile}</div>
                  <div className="stat-description">average connectivity</div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">Isolated Files</div>
                  <div className="stat-value">{stats.isolatedFiles}</div>
                  <div className="stat-description">notes with no links</div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">Cycles Detected</div>
                  <div className="stat-value">{stats.cycles}</div>
                  <div className="stat-description">circular references</div>
                </div>

                <div className="stat-card">
                  <div className="stat-label">Connectivity</div>
                  <div className="stat-value">
                    {stats.totalFiles > 0
                      ? (() => {
                          // We define a "saturation point" where we consider the graph "fully connected" for human standards.
                          // 10 links per note is 100% score.
                          const TARGET_DENSITY = 10;
                          const avgDegree = stats.totalLinks / stats.totalFiles;
                          const score = Math.min((avgDegree / TARGET_DENSITY) * 100, 100);
                          return Math.round(score);
                        })()
                      : 0}
                    %
                  </div>
                  <div className="stat-description">saturation score</div>
                </div>
              </div>

              {stats.mostLinked.length > 0 && (
                <div className="most-linked-section">
                  <h2>Most Referenced Notes</h2>
                  <div className="most-linked-list">
                    {stats.mostLinked.map((item, index) => (
                      <div key={item.file} className="most-linked-item">
                        <div className="rank-badge">#{index + 1}</div>
                        <div className="link-info">
                          <div className="link-filename">{item.file.replace(/\.md$/, '')}</div>
                          <div className="link-count">{item.backlinks} backlinks</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="graph-insights">
                <h2>Insights</h2>
                <ul className="insights-list">
                  {stats.totalFiles === 0 && (
                    <li>Start creating notes and linking them together to build your graph</li>
                  )}
                  {stats.totalFiles > 0 && stats.isolatedFiles === stats.totalFiles && (
                    <li>
                      Your notes aren&apos;t linked yet. Consider creating connections between
                      related notes
                    </li>
                  )}
                  {stats.isolatedFiles > 0 && stats.isolatedFiles < stats.totalFiles && (
                    <li>
                      {stats.isolatedFiles} note
                      {stats.isolatedFiles !== 1 ? 's are' : ' is'}
                      {' isolated. Consider linking them to your existing notes'}
                    </li>
                  )}
                  {stats.cycles > 0 && (
                    <li>
                      You have {stats.cycles} circular reference
                      {stats.cycles !== 1 ? 's' : ''} in your graph
                    </li>
                  )}
                  {stats.avgLinksPerFile > 5 && (
                    <li>
                      Your graph is well-connected! You&apos;re creating strong connections between
                      ideas
                    </li>
                  )}
                  {stats.avgLinksPerFile > 10 && (
                    <li>Excellent connectivity! Your vault is becoming a rich knowledge base</li>
                  )}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

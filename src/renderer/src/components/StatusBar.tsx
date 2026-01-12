import React, { useMemo } from 'react';
import { calculateReadingStats, formatReadTime, formatWordCount } from '../utils/readingStats';

export type Status = { type: string; message: string } | null;

export function StatusBar({
  status,
  content,
  isVaultEncrypted = false,
  isVaultUnlocked = false
}: {
  status: Status;
  content?: string;
  isVaultEncrypted?: boolean;
  isVaultUnlocked?: boolean;
}): React.JSX.Element {
  const stats = useMemo(() => {
    if (!content) return null;
    return calculateReadingStats(content);
  }, [content]);

  const getIcon = (type?: string): string => {
    switch (type) {
      case 'indexing-started':
        return '⟳';
      case 'indexing-complete':
        return '✓';
      case 'cache-loaded':
        return '📦';
      case 'vault-opened':
        return '📁';
      case 'error':
        return '⚠';
      default:
        return '';
    }
  };

  const statusClass = status ? status.type : 'idle';

  return (
    <div className={`status-bar ${statusClass}`}>
      {isVaultEncrypted && (
        <span
          className="status-bar-encryption-icon"
          title={isVaultUnlocked ? 'Vault is encrypted and unlocked' : 'Vault is encrypted'}
        >
          🔐
        </span>
      )}
      {status ? (
        <>
          <span className="status-bar-icon">{getIcon(status.type)}</span>
          <span className="status-bar-message">{status.message}</span>
        </>
      ) : (
        <>
          <span className="status-bar-message">Ready</span>
          {stats && (
            <div className="reading-stats">
              <span className="stat-item">{formatWordCount(stats.wordCount)}</span>
              <span className="stat-separator">•</span>
              <span className="stat-item">{formatReadTime(stats)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default StatusBar;

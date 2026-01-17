import React, { useMemo } from 'react';
import 'material-symbols';
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

  const getIcon = (type?: string): React.ReactNode => {
    const cls = 'material-symbols-outlined';
    switch (type) {
      case 'indexing-started':
        return <span className={cls}>autorenew</span>;
      case 'indexing-complete':
        return <span className={cls}>check</span>;
      case 'cache-loaded':
        return <span className={cls}>inventory_2</span>;
      case 'vault-opened':
        return <span className={cls}>folder_open</span>;
      case 'error':
        return <span className={cls}>warning</span>;
      default:
        return null;
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
          <span className="material-symbols-outlined">encrypted</span>
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

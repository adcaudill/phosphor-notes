import React from 'react';

export type Status = { type: string; message: string } | null;

export function StatusBar({ status }: { status: Status }): React.JSX.Element {
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
            {status ? (
                <>
                    <span className="status-bar-icon">{getIcon(status.type)}</span>
                    <span className="status-bar-message">{status.message}</span>
                </>
            ) : (
                <span className="status-bar-message">Ready</span>
            )}
        </div>
    );
}

export default StatusBar;

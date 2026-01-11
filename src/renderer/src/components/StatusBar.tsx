import React from 'react';

export type Status = { type: string; message: string } | null;

export function StatusBar({ status }: { status: Status }): React.JSX.Element {
  const baseStyle: React.CSSProperties = {
    minHeight: 36,
    padding: '8px 12px',
    borderTop: '1px solid #eee',
    display: 'flex',
    alignItems: 'center',
    fontSize: 13,
    background: '#fafafa',
    color: '#333'
  };

  const getHighlight = (type?: string): React.CSSProperties => {
    switch (type) {
      case 'indexing-started':
        return { background: '#fff8e1' };
      case 'indexing-complete':
        return { background: '#e8f5e9' };
      case 'error':
        return { background: '#ffebee', color: '#a00' };
      default:
        return {};
    }
  };

  return (
    <div style={{ ...baseStyle, ...(status ? getHighlight(status.type) : {}) }}>
      {status ? <span>{status.message}</span> : <span style={{ opacity: 0.6 }}> </span>}
    </div>
  );
}

export default StatusBar;

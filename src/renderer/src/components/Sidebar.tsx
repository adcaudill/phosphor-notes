import React, { useState, useEffect } from 'react';

interface SidebarProps {
  onFileSelect: (filename: string) => void;
  activeFile: string | null;
  refreshSignal?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({ onFileSelect, activeFile, refreshSignal }) => {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    const fetchFiles = async () => {
      const fileList = await window.phosphor.listFiles();
      setFiles(fileList);
    };

    fetchFiles();
  }, [refreshSignal]);

  return (
    <div className="sidebar">
      <div className="sidebar-drag-area" />
      <h2>Notes</h2>
      <ul>
        {files.map((file) => (
          <li
            key={file}
            className={file === activeFile ? 'active' : ''}
            onClick={() => {
              try {
                console.debug('Sidebar click:', file);
              } catch { }
              onFileSelect(file);
            }}
          >
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
};

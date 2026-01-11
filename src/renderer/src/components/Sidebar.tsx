import React, { useState, useEffect } from 'react';

interface SidebarProps {
  onFileSelect: (filename: string) => void;
  activeFile: string | null;
}

export const Sidebar: React.FC<SidebarProps> = ({ onFileSelect, activeFile }) => {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    const fetchFiles = async () => {
      const fileList = await window.phosphor.listFiles();
      setFiles(fileList);
    };

    fetchFiles();
  }, []);

  return (
    <div className="sidebar">
      <h2>Notes</h2>
      <ul>
        {files.map((file) => (
          <li
            key={file}
            className={file === activeFile ? 'active' : ''}
            onClick={() => onFileSelect(file)}
          >
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
};

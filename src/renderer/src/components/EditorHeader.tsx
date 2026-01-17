import React from 'react';

type Props = {
  handleHeaderMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  viewMode: 'editor' | 'tasks' | 'graph';
  titleEditMode: boolean;
  editingTitle: string;
  onEditingTitleChange: (v: string) => void;
  onTitleSave: (title: string) => void;
  onTitleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onTitleDoubleClick: (e: React.MouseEvent<HTMLHeadingElement>) => void;
  onOpenFrontmatter: () => void;
  onToggleInformationSidebar: () => void;
  currentTitle: string;
};

export default function EditorHeader({
  handleHeaderMouseDown,
  viewMode,
  titleEditMode,
  editingTitle,
  onEditingTitleChange,
  onTitleSave,
  onTitleKeyDown,
  onTitleDoubleClick,
  onOpenFrontmatter,
  onToggleInformationSidebar,
  currentTitle
}: Props): React.JSX.Element {
  return (
    <div className="editor-header" onMouseDown={handleHeaderMouseDown}>
      {viewMode === 'editor' && titleEditMode ? (
        <input
          type="text"
          className="editor-title-input"
          value={editingTitle}
          onChange={(e) => onEditingTitleChange(e.target.value)}
          onBlur={() => onTitleSave(editingTitle)}
          onKeyDown={onTitleKeyDown}
          autoFocus
        />
      ) : (
        <h1
          className="editor-title"
          onDoubleClick={onTitleDoubleClick}
          style={viewMode === 'editor' ? { cursor: 'text' } : {}}
        >
          {currentTitle}
        </h1>
      )}
      {viewMode === 'editor' && !titleEditMode && (
        <div className="editor-header-actions">
          <button className="settings-btn" onClick={onOpenFrontmatter} title="Edit file settings">
            <span className="material-symbols-outlined">edit_attributes</span>
          </button>
          <button
            className="information-toggle"
            onClick={onToggleInformationSidebar}
            title="Toggle information panel"
          >
            <span className="material-symbols-outlined">info</span>
          </button>
        </div>
      )}
    </div>
  );
}

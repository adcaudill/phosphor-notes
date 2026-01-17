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
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
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
  currentTitle,
  onNavigateBack,
  onNavigateForward,
  canGoBack,
  canGoForward
}: Props): React.JSX.Element {
  return (
    <div className="editor-header" onMouseDown={handleHeaderMouseDown}>
      {viewMode === 'editor' && (
        <div className="editor-nav-buttons">
          <button className="nav-back" onClick={onNavigateBack} disabled={!canGoBack} title="Back">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <button
            className="nav-forward"
            onClick={onNavigateForward}
            disabled={!canGoForward}
            title="Forward"
          >
            <span className="material-symbols-outlined">arrow_forward</span>
          </button>
        </div>
      )}
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

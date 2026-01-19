import React, { useState, useRef, forwardRef } from 'react';
import DatePicker from 'react-datepicker';
import type ReactDatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

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
  onOpenFile?: (filename: string) => void;
  currentFile?: string | null;
};

const CustomButton = forwardRef<
  HTMLButtonElement,
  {
    toggleOpen?: () => void;
    className?: string;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  }
>(({ toggleOpen, className, ...rest }, ref) => {
  const base = String(className ?? '').trim();
  const appliedClass = base ? `${base} calendar-btn` : 'calendar-btn';
  return (
    <button
      className={appliedClass}
      onMouseDown={(e) => {
        console.debug('[EditorHeader] CustomButton onMouseDown');
        // Prevent react-datepicker's injected click handler from double-toggling
        e.preventDefault();
        if (toggleOpen) {
          console.debug('[EditorHeader] calling toggleOpen');
          toggleOpen();
        }
      }}
      ref={ref}
      title="Open calendar"
      {...rest}
    >
      <span className="material-symbols-outlined">calendar_month</span>
    </button>
  );
});
CustomButton.displayName = 'CustomButton';

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
  canGoForward,
  onOpenFile,
  currentFile
}: Props): React.JSX.Element {
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const dpRef = useRef<ReactDatePicker | null>(null);
  const suppressOpenRef = useRef<boolean>(false);
  const [isFavorite, setIsFavorite] = useState<boolean>(false);

  React.useEffect(() => {
    let mounted = true;
    const loadFav = async (): Promise<void> => {
      if (!currentFile) {
        setIsFavorite(false);
        return;
      }
      try {
        const favs = await window.phosphor.getFavorites();
        if (!mounted) return;
        setIsFavorite(favs.includes(currentFile));
      } catch (err) {
        console.debug('Failed to load favorites:', err);
      }
    };
    loadFav();
    return () => {
      mounted = false;
    };
  }, [currentFile]);

  const handleDateSelect = (date: Date | null): void => {
    setSelectedDate(date);
    setIsOpen(false);
    if (!date) return;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const filename = `${year}-${month}-${day}.md`;
    if (onOpenFile) onOpenFile(filename);
  };
  React.useEffect(() => {
    console.debug('[EditorHeader] datepicker isOpen ->', isOpen);
  }, [isOpen]);

  React.useEffect(() => {
    console.debug('[EditorHeader] selectedDate ->', selectedDate);
  }, [selectedDate]);
  return (
    <div className="editor-header" onMouseDown={handleHeaderMouseDown}>
      {viewMode === 'editor' && (
        <div className="editor-nav-buttons">
          <button className="nav-back" onClick={onNavigateBack} disabled={!canGoBack} title="Back">
            <span className="material-symbols-outlined">arrow_back_ios</span>
          </button>
          <button
            className="nav-forward"
            onClick={onNavigateForward}
            disabled={!canGoForward}
            title="Forward"
          >
            <span className="material-symbols-outlined">arrow_forward_ios</span>
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
          {viewMode === 'editor' && currentFile && (
            <button
              className="favorite-btn"
              onClick={async () => {
                try {
                  const updated = await window.phosphor.toggleFavorite(currentFile);
                  setIsFavorite(updated.includes(currentFile));
                } catch (err) {
                  console.debug('Failed to toggle favorite:', err);
                }
              }}
              title={isFavorite ? 'Remove favorite' : 'Add to favorites'}
            >
              <span className="material-symbols-outlined">
                {isFavorite ? 'bookmark_check' : 'bookmark_add'}
              </span>
            </button>
          )}
          <DatePicker
            selected={selectedDate}
            onChange={(d) => handleDateSelect(d)}
            customInput={
              <CustomButton
                toggleOpen={() => {
                  const inst = dpRef.current;
                  console.debug('[EditorHeader] toggleOpen, dpRef.current ->', inst);
                  if (inst?.setOpen) {
                    const openNow =
                      typeof inst.isCalendarOpen === 'boolean'
                        ? inst.isCalendarOpen
                        : inst?.state?.open;
                    console.debug('[EditorHeader] instance openNow ->', openNow);
                    if (typeof openNow === 'boolean') {
                      if (openNow) {
                        // closing: explicitly close and suppress immediate reopen
                        suppressOpenRef.current = true;
                        inst.setOpen(false);
                        window.setTimeout(() => {
                          suppressOpenRef.current = false;
                        }, 200);
                      } else {
                        inst.setOpen(true);
                      }
                    } else {
                      inst.setOpen(true);
                    }
                  } else {
                    setIsOpen((v) => !v);
                  }
                }}
              />
            }
            onCalendarOpen={() => {
              if (suppressOpenRef.current) {
                console.debug('[EditorHeader] suppressed onCalendarOpen');
                dpRef.current?.setOpen(false);
                return;
              }
              setIsOpen(true);
            }}
            onCalendarClose={() => setIsOpen(false)}
            onClickOutside={() => setIsOpen(false)}
            ref={dpRef}
            dateFormat="yyyy-MM-dd"
            placeholderText="Pick date"
            popperPlacement="bottom-end"
          />
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

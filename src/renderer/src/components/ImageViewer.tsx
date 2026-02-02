import { useEffect, useRef, useState, useCallback, ReactNode } from 'react';

interface ImageViewerProps {
  isOpen: boolean;
  imageUrl: string;
  onClose: () => void;
}

export const ImageViewer = ({ isOpen, imageUrl, onClose }: ImageViewerProps): ReactNode => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset state when opening a new image
  useEffect(() => {
    if (isOpen) {
      // Use a microtask to batch the state updates
      queueMicrotask(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setIsDragging(false);
      });
    }
  }, [isOpen, imageUrl]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!isOpen) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case '+':
        case '=':
          e.preventDefault();
          setZoom((z) => Math.min(z + 0.2, 4));
          break;
        case '-':
          e.preventDefault();
          setZoom((z) => Math.max(z - 0.2, 1));
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }
          break;
        default:
          break;
      }
    },
    [isOpen, onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  // Handle wheel zoom
  const handleWheel = useCallback(
    (e: WheelEvent): void => {
      if (!isOpen || !containerRef.current) return;

      e.preventDefault();

      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.min(Math.max(z + delta, 1), 4));
    },
    [isOpen]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Handle mouse drag for panning
  const handleMouseDown = (e: React.MouseEvent): void => {
    if (zoom <= 1) return; // Only allow panning when zoomed in

    setIsDragging(true);
    setDragStart({
      x: e.clientX - pan.x,
      y: e.clientY - pan.y
    });
  };

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (!isDragging || !containerRef.current) return;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    // Constrain pan to reasonable bounds
    const maxPan = (zoom - 1) * 100;
    setPan({
      x: Math.max(Math.min(newX, maxPan), -maxPan),
      y: Math.max(Math.min(newY, maxPan), -maxPan)
    });
  };

  const handleMouseUp = (): void => {
    setIsDragging(false);
  };

  if (!isOpen) return null;

  return (
    <div className="image-viewer-overlay" onClick={onClose}>
      <div
        ref={containerRef}
        className="image-viewer-container"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt="Viewer"
          className="image-viewer-image"
          style={{
            transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`
          }}
          draggable={false}
        />
      </div>

      {/* Controls */}
      <div className="image-viewer-controls">
        <div className="image-viewer-controls-group">
          <button
            className="image-viewer-button"
            onClick={() => setZoom((z) => Math.max(z - 0.2, 1))}
            title="Zoom out (- key)"
          >
            −
          </button>

          <span className="image-viewer-zoom-level">{Math.round(zoom * 100)}%</span>

          <button
            className="image-viewer-button"
            onClick={() => setZoom((z) => Math.min(z + 0.2, 4))}
            title="Zoom in (+ key)"
          >
            +
          </button>

          <button
            className="image-viewer-button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            title="Reset zoom (Ctrl+0)"
          >
            ↺
          </button>
        </div>

        <button
          className="image-viewer-button image-viewer-close-button"
          onClick={onClose}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {/* Help text */}
      <div className="image-viewer-help">
        <span>Scroll to zoom • Drag to pan • ESC to close</span>
      </div>
    </div>
  );
};

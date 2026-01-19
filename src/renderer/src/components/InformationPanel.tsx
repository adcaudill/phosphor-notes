import React, { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { calculateReadingStats, formatReadTime, formatWordCount } from '../utils/readingStats';
import rs from 'text-readability';

interface DocumentHeader {
  level: number; // 1-6 for h1-h6
  text: string;
  lineNumber: number; // Line number in the document (1-indexed)
}

interface InformationPanelProps {
  currentFile: string | null;
  content: string;
  graph: Record<string, string[]>;
  backlinks: Record<string, string[]>;
  onFileSelect: (filename: string) => void;
  onHeaderClick?: (lineNumber: number) => void;
}

/**
 * Extract markdown headers (h1-h6) from document content
 */
function extractHeadersFromContent(content: string): DocumentHeader[] {
  const headers: DocumentHeader[] = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const headerRegex = /^(#{1,6})\s+(.+?)(?:\s*\{#[^}]+\})?$/;
    const match = line.match(headerRegex);

    if (match) {
      const level = match[1].length; // Number of # symbols (1-6)
      const text = match[2].trim();

      headers.push({
        level,
        text,
        lineNumber: index + 1 // 1-indexed line number
      });
    }
  });

  return headers;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Find mentions of `currentBase` in `content` and return joined preview snippets.
 * For each mention capture the mention line + `afterLines` following lines.
 * Overlapping captures are collapsed.
 */
function getMentionsPreview(content: string, currentBase: string, afterLines = 5): string {
  if (!currentBase) return '';

  const lines = content.split('\n');

  // Skip YAML frontmatter at start if present
  let startIdx = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        startIdx = i + 1;
        break;
      }
    }
  }

  const escaped = escapeRegExp(currentBase);
  const mentionRegex = new RegExp(
    `\\[\\[\\s*${escaped}(?:\\|[^\\]]*)?\\s*\\]\\]|\\b${escaped}(?:\\.md)?\\b`,
    'i'
  );

  const snippets: string[] = [];
  let lastEndLine = -1;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (mentionRegex.test(line)) {
      const snippetStart = i;
      const snippetEnd = Math.min(lines.length, i + afterLines + 1);

      if (snippetStart <= lastEndLine) {
        // already covered
        continue;
      }

      const rawSnippet = lines.slice(snippetStart, snippetEnd).join('\n').trim();

      // Highlight mentions safely by escaping non-matching parts and wrapping matches in <strong>
      const highlightRegex = new RegExp(
        `\\[\\[\\s*${escaped}(?:\\|[^\\]]*)?\\s*\\]\\]|\\b${escaped}(?:\\.md)?\\b`,
        'ig'
      );

      let highlighted = '';
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = highlightRegex.exec(rawSnippet)) !== null) {
        const idx = m.index;
        const matchText = m[0];
        highlighted += escapeHTML(rawSnippet.slice(lastIndex, idx));
        highlighted += `<u><strong>${escapeHTML(matchText)}</strong></u>`;
        lastIndex = idx + matchText.length;
      }
      if (lastIndex < rawSnippet.length) highlighted += escapeHTML(rawSnippet.slice(lastIndex));

      snippets.push(highlighted);
      lastEndLine = snippetEnd - 1;
    }
  }

  // If no mentions found, fallback to first 20 lines (like wiki preview)
  if (snippets.length === 0) {
    const previewLines = lines.slice(startIdx, startIdx + 20);
    return escapeHTML(previewLines.join('\n').trim());
  }

  // Join with separators (preserve as plaintext inside <pre>)
  return snippets.map((s) => s.trim()).join('\n\n...\n\n');
}

/**
 * Strip common Markdown/Frontmatter constructs to produce plain text
 * for readability calculations.
 */
function plainTextForReadability(doc: string): string {
  // Remove frontmatter
  const fm = doc.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) doc = doc.slice(fm[0].length);

  // Remove code fences
  doc = doc.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code
  doc = doc.replace(/`[^`]*`/g, ' ');
  // Remove images and links but keep alt/text
  doc = doc.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  doc = doc.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Remove wiki-links [[Page|Text]] -> Text or [[Page]] -> Page
  doc = doc.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, p1, p2) => p2 || p1);
  // Remove headings, emphasis, and remaining markdown punctuation
  doc = doc.replace(/^#{1,6}\s+/gm, ' ');
  doc = doc.replace(/[*_]{1,3}/g, '');
  // Remove HTML tags
  doc = doc.replace(/<[^>]+>/g, ' ');
  // Collapse whitespace
  return doc.replace(/\s+/g, ' ').trim();
}

export const InformationPanel: React.FC<InformationPanelProps> = ({
  currentFile,
  content,
  graph,
  backlinks,
  onFileSelect,
  onHeaderClick
}) => {
  const headers = useMemo(() => extractHeadersFromContent(content), [content]);

  // Reading stats for the current document
  const stats = useMemo(() => calculateReadingStats(content || ''), [content]);

  // Reading-aloud estimate and readability metrics (derived via memo)
  const { fleschEase, kincaidGrade } = useMemo(() => {
    try {
      const plain = plainTextForReadability(content || '');
      return {
        fleschEase: Number(rs.fleschReadingEase(plain)),
        kincaidGrade: Number(rs.fleschKincaidGrade(plain))
      };
    } catch {
      return { fleschEase: null, kincaidGrade: null };
    }
  }, [content]);

  // Tooltip state for previews of incoming files (simple: positioned next to link)
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    content: string;
    title?: string;
    x: number;
    y: number;
    width?: number;
    bodyMaxHeight?: number;
  }>({ visible: false, content: '', x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);
  const showTimeoutRef = useRef<number | null>(null);

  // Clear any inline styles when tooltip closes to avoid stale positioning
  useEffect(() => {
    if (!tooltip.visible && tooltipRef.current) {
      const el = tooltipRef.current as HTMLElement;
      try {
        el.style.top = '';
        el.style.maxHeight = '';
        el.style.overflowY = '';
        const body = el.querySelector('.cm-wiki-preview-body') as HTMLElement | null;
        if (body) {
          body.style.maxHeight = '';
          body.style.overflowY = '';
        }
      } catch {
        // ignore
      }
    }
  }, [tooltip.visible]);

  useEffect(() => {
    function onScroll(e: Event): void {
      const target = e.target as Node | null;
      if (tooltipRef.current && target && tooltipRef.current.contains(target)) {
        return;
      }

      if (tooltip.visible) setTooltip((t) => ({ ...t, visible: false }));
    }

    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [tooltip.visible]);

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      if (showTimeoutRef.current) {
        window.clearTimeout(showTimeoutRef.current);
        showTimeoutRef.current = null;
      }
    };
  }, []);

  const { outgoing, incoming, totalConnections } = useMemo(() => {
    if (!currentFile) {
      return { outgoing: [], incoming: [], totalConnections: 0 };
    }

    // Normalize lookup for graph/backlinks keys: some producers store filenames
    // with or without the `.md` extension. Try several variants to find matches.
    const tryLookup = (obj: Record<string, string[]>, key: string): string[] => {
      if (!obj) return [];
      if (obj[key]) return obj[key];
      const noExt = key.replace(/\.md$/i, '');
      if (obj[noExt]) return obj[noExt];
      const withExt = key.endsWith('.md') ? key : `${key}.md`;
      if (obj[withExt]) return obj[withExt];
      return [];
    };

    // Only include markdown files (.md extension)
    const out = tryLookup(graph, currentFile).filter((f) => f.endsWith('.md'));
    const inc = tryLookup(backlinks, currentFile).filter((f) => f.endsWith('.md'));
    return {
      outgoing: out,
      incoming: inc,
      totalConnections: out.length + inc.length
    };
  }, [currentFile, graph, backlinks]);

  if (!currentFile) {
    return null;
  }

  const hasConnections = totalConnections > 0;
  const hasHeaders = headers.length > 0;

  // prepare reading-aloud estimate
  const readAloudSeconds = Math.ceil((stats.wordCount / 130) * 60);
  const readAloudStats = {
    ...stats,
    readTimeMinutes: Math.floor(readAloudSeconds / 60),
    readTimeSeconds: readAloudSeconds % 60
  };

  return (
    <div className="information-panel">
      {/* Document Outline Section */}
      {hasHeaders && (
        <div className="information-section outline-section">
          <div className="information-section-header">
            <span className="information-section-title">Document Outline</span>
            <span className="information-section-count">
              {headers.length} section{headers.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="outline-items">
            {headers.map((header) => (
              <button
                key={`${header.lineNumber}-${header.text}`}
                className={`outline-item outline-level-${header.level}`}
                onClick={() => {
                  if (onHeaderClick) {
                    onHeaderClick(header.lineNumber);
                  }
                }}
                title={header.text}
                style={{
                  paddingLeft: `${(header.level - 1) * 0.75}rem`
                }}
              >
                <span className="outline-item-text">{header.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Document Information Section */}
      <div className="information-section">
        <div className="information-section-header">
          <span className="information-section-title">Document Information</span>
        </div>
        <div className="information-content">
          <div className="doc-info-table">
            <div className="doc-info-row">
              <div className="doc-info-key">Word Count</div>
              <div className="doc-info-value">{formatWordCount(stats.wordCount)}</div>
            </div>
            <div className="doc-info-row">
              <div className="doc-info-key">Reading Time</div>
              <div className="doc-info-value">{formatReadTime(stats)}</div>
            </div>
            <div className="doc-info-row">
              <div className="doc-info-key">Reading Time (Aloud)</div>
              <div className="doc-info-value">{formatReadTime(readAloudStats)}</div>
            </div>
            <div className="doc-info-row">
              <div className="doc-info-key">Flesch Reading Ease</div>
              <div className="doc-info-value">
                {fleschEase != null ? fleschEase.toFixed(1) : '—'}
              </div>
            </div>
            <div className="doc-info-row">
              <div className="doc-info-key">Flesch-Kincaid Grade</div>
              <div className="doc-info-value">
                {kincaidGrade != null ? kincaidGrade.toFixed(1) : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Document Relationships Section */}
      <div className="information-section">
        <div className="information-section-header">
          <span className="information-section-title">Document Relationships</span>
          <span className="information-section-count">
            {totalConnections} connection{totalConnections !== 1 ? 's' : ''}
          </span>
        </div>

        {!hasConnections ? (
          <div className="information-empty">
            <em>No connections</em>
          </div>
        ) : (
          <div className="information-content">
            {/* Incoming Links (Backlinks) */}
            {incoming.length > 0 && (
              <div className="information-group">
                <div className="information-group-header">
                  <span className="information-group-title">Linked from ({incoming.length})</span>
                </div>
                <div className="information-group-items">
                  {incoming.map((file) => (
                    <button
                      key={file}
                      className="information-item incoming"
                      onClick={() => onFileSelect(file)}
                      title={file}
                      onMouseEnter={(e) => {
                        // Cancel pending hide
                        if (hideTimeoutRef.current) {
                          window.clearTimeout(hideTimeoutRef.current);
                          hideTimeoutRef.current = null;
                        }

                        // Clear any pending show timer (we're entering a new target)
                        if (showTimeoutRef.current) {
                          window.clearTimeout(showTimeoutRef.current);
                          showTimeoutRef.current = null;
                        }

                        // Position tooltip using available space to decide width/x now.
                        const target = e.currentTarget as HTMLElement;
                        const rect = target.getBoundingClientRect();

                        const margin = 8;
                        const maxPreviewWidth = Math.min(500, Math.floor(window.innerWidth * 0.44));

                        const spaceRight = Math.max(0, window.innerWidth - rect.right - margin);
                        const spaceLeft = Math.max(0, rect.left - margin);

                        // Prefer right placement if there's enough room; otherwise left.
                        let placeRight = spaceRight >= Math.min(240, maxPreviewWidth);

                        // If neither side has room, pick the side with more space
                        if (!placeRight && spaceLeft > spaceRight) placeRight = false;

                        let width = Math.min(maxPreviewWidth, placeRight ? spaceRight : spaceLeft);
                        // Ensure a sensible minimum width
                        if (width < 160) width = Math.min(maxPreviewWidth, Math.max(width, 120));

                        let x: number;
                        if (placeRight) {
                          x = Math.min(window.innerWidth - margin - width, rect.right + 8);
                        } else {
                          x = Math.max(margin, rect.left - 8 - width);
                        }

                        const SHOW_DELAY = 400; // ms

                        // Schedule showing the preview after a short delay
                        showTimeoutRef.current = window.setTimeout(() => {
                          showTimeoutRef.current = null;

                          (async () => {
                            try {
                              const raw = await window.phosphor.readNote(file);
                              const currentBase = (currentFile || '').replace(/\.md$/i, '');
                              const preview = getMentionsPreview(raw, currentBase, 5) || '(empty)';

                              // Pre-measure offscreen to decide final y and optional clamp
                              const measure = document.createElement('div');
                              measure.className = 'cm-wiki-preview-tooltip';
                              measure.style.position = 'fixed';
                              measure.style.left = '-9999px';
                              measure.style.top = '0px';
                              measure.style.visibility = 'hidden';
                              measure.style.zIndex = '0';
                              measure.style.width = `${width}px`;

                              const contentWrap = document.createElement('div');
                              contentWrap.className = 'cm-wiki-preview-content';

                              const titleEl = document.createElement('div');
                              titleEl.className = 'cm-wiki-preview-title';
                              titleEl.textContent = file;

                              const pre = document.createElement('pre');
                              pre.className = 'cm-wiki-preview-body';
                              pre.textContent = preview;

                              contentWrap.appendChild(titleEl);
                              contentWrap.appendChild(pre);
                              measure.appendChild(contentWrap);
                              document.body.appendChild(measure);

                              const rectMeasure = measure.getBoundingClientRect();
                              const contentHeight = rectMeasure.height;
                              const margin = 8;
                              const viewportBottom = window.innerHeight - margin;
                              const viewportAvail = Math.max(80, window.innerHeight - margin * 2);

                              let finalY = rect.top;
                              if (finalY + contentHeight + margin > window.innerHeight) {
                                finalY = Math.max(margin, viewportBottom - contentHeight);
                              }

                              let bodyMaxHeight: number | undefined;
                              if (contentHeight > viewportAvail) {
                                bodyMaxHeight = Math.max(
                                  80,
                                  window.innerHeight - margin - finalY - 4
                                );
                              }

                              document.body.removeChild(measure);

                              setTooltip({
                                visible: true,
                                content: preview,
                                title: file,
                                x,
                                y: finalY,
                                width,
                                bodyMaxHeight
                              });
                            } catch {
                              setTooltip((t) => ({ ...t, content: `File not found: ${file}` }));
                            }
                          })();
                        }, SHOW_DELAY);
                      }}
                      onMouseMove={(e) => {
                        // Cancel pending hide while moving inside the target
                        if (hideTimeoutRef.current) {
                          window.clearTimeout(hideTimeoutRef.current);
                          hideTimeoutRef.current = null;
                        }

                        // Keep tooltip anchored relative to the element using same placement logic
                        const target = e.currentTarget as HTMLElement;
                        const rect = target.getBoundingClientRect();
                        const margin = 8;
                        const maxPreviewWidth = Math.min(500, Math.floor(window.innerWidth * 0.44));
                        const spaceRight = window.innerWidth - rect.right;
                        let x: number;
                        if (spaceRight >= maxPreviewWidth + 12) {
                          x = Math.min(
                            window.innerWidth - margin - maxPreviewWidth,
                            rect.right + 8
                          );
                        } else {
                          x = Math.max(margin, rect.left - 8 - maxPreviewWidth);
                        }
                        // Only adjust x during move; keep y to avoid jitter once clamped
                        setTooltip((t) => ({ ...t, x }));
                      }}
                      onMouseLeave={() => {
                        // Delay hiding slightly to avoid flicker when tooltip overlaps
                        if (hideTimeoutRef.current) {
                          window.clearTimeout(hideTimeoutRef.current);
                        }
                        if (showTimeoutRef.current) {
                          window.clearTimeout(showTimeoutRef.current);
                          showTimeoutRef.current = null;
                        }
                        hideTimeoutRef.current = window.setTimeout(() => {
                          setTooltip((t) => ({ ...t, visible: false }));
                          hideTimeoutRef.current = null;
                        }, 140);
                      }}
                    >
                      <span className="information-item-icon">←</span>
                      <span className="information-item-name">{file}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Outgoing Links */}
            {outgoing.length > 0 && (
              <div className="information-group">
                <div className="information-group-header">
                  <span className="information-group-title">Links to ({outgoing.length})</span>
                </div>
                <div className="information-group-items">
                  {outgoing.map((file) => (
                    <button
                      key={file}
                      className="information-item outgoing"
                      onClick={() => onFileSelect(file)}
                      title={file}
                    >
                      <span className="information-item-name">{file}</span>
                      <span className="information-item-icon">→</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {/* Floating tooltip for previews (render outside conditionals) */}
      {tooltip.visible &&
        createPortal(
          <div
            ref={tooltipRef}
            className="cm-wiki-preview-tooltip"
            onMouseEnter={() => {
              // Cancel pending hide while hovering tooltip
              if (hideTimeoutRef.current) {
                window.clearTimeout(hideTimeoutRef.current);
                hideTimeoutRef.current = null;
              }
            }}
            onMouseLeave={() => {
              if (hideTimeoutRef.current) window.clearTimeout(hideTimeoutRef.current);
              hideTimeoutRef.current = window.setTimeout(() => {
                setTooltip((t) => ({ ...t, visible: false }));
                hideTimeoutRef.current = null;
              }, 140);
            }}
            style={{
              position: 'fixed',
              left: tooltip.x,
              top: tooltip.y,
              zIndex: 10000,
              width: tooltip.width ? tooltip.width : undefined
            }}
          >
            <div className="cm-wiki-preview-content">
              <div className="cm-wiki-preview-title">{tooltip.title || ''}</div>
              <pre
                className="cm-wiki-preview-body"
                style={
                  tooltip.bodyMaxHeight
                    ? { maxHeight: `${tooltip.bodyMaxHeight}px`, overflowY: 'auto' }
                    : undefined
                }
                // We trust the preview generation to sanitize appropriately
                // Doing this to allow <strong> highlights
                dangerouslySetInnerHTML={{ __html: tooltip.content }}
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

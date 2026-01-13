import React, { useEffect, useRef, useMemo } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, KeyBinding } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { wikiLinkPlugin } from '../editor/extensions/wikiLinks';
import { imagePreviewPlugin } from '../editor/extensions/imagePreview';
import { taskCheckboxPlugin, cycleTaskStatus } from '../editor/extensions/taskCheckbox';
import { dateIndicatorPlugin } from '../editor/extensions/dateIndicator';
import { typewriterScrollPlugin } from '../editor/extensions/typewriter';
import { dimmingPlugin } from '../editor/extensions/dimming';
import {
  extractFrontmatter,
  reconstructDocument,
  type Frontmatter
} from '../utils/frontmatterUtils';

// Dark mode highlight style with proper color contrast
const darkModeHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.heading1, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.heading2, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.heading3, color: '#60a5fa', fontWeight: 'bold' },
  { tag: t.processingInstruction, color: '#b0b0b0' }, // For --- and similar
  { tag: t.punctuation, color: '#b0b0b0' },
  { tag: t.quote, color: '#78716c', fontStyle: 'italic' },
  { tag: t.link, color: '#60a5fa' },
  { tag: t.url, color: '#4ade80' },
  { tag: t.emphasis, color: '#ecf0f1', fontStyle: 'italic' },
  { tag: t.strong, color: '#ecf0f1', fontWeight: 'bold' },
  { tag: t.strikethrough, color: '#6b7280', textDecoration: 'line-through' },
  { tag: t.meta, color: '#b0b0b0' },
  { tag: t.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.atom, color: '#b0b0b0' },
  { tag: t.keyword, color: '#b0b0b0' },
  { tag: t.string, color: '#f87171' },
  { tag: t.variableName, color: '#ecf0f1' }
]);

interface EditorProps {
  initialDoc: string;
  onChange: (doc: string) => void;
  onLinkClick?: (link: string) => void;
  enableDimming?: boolean;
}

export const Editor: React.FC<EditorProps> = ({
  initialDoc,
  onChange,
  onLinkClick,
  enableDimming = false
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onLinkClickRef = useRef(onLinkClick);
  const frontmatterRef = useRef<Frontmatter | null>(null);

  // Extract frontmatter and content, memoized to avoid re-extraction on every render
  const { frontmatter, content } = useMemo(() => extractFrontmatter(initialDoc), [initialDoc]);

  // Update the frontmatter ref whenever extraction changes
  useEffect(() => {
    frontmatterRef.current = frontmatter;
  }, [frontmatter]);

  // Keep refs up-to-date so CodeMirror listeners call the latest handlers
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  useEffect(() => {
    if (!editorRef.current) return;

    // 1. Define the Initial State (use only the content, without frontmatter)
    const startState = EditorState.create({
      doc: content,
      extensions: [
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: 'Mod-Enter',
            run: cycleTaskStatus
          } as KeyBinding
        ]), // Cmd+Z, Enter, etc.
        EditorView.lineWrapping, // Soft wrap long lines
        markdown(), // Markdown syntax support
        history(), // Undo/Redo stack
        syntaxHighlighting(darkModeHighlightStyle), // Use custom dark mode colors
        taskCheckboxPlugin, // Task checkboxes
        dateIndicatorPlugin, // Date pill indicators
        typewriterScrollPlugin, // Typewriter scrolling (cursor centered)
        ...(enableDimming ? [dimmingPlugin] : []), // Paragraph dimming (optional)

        // 2. Listener for changes (call latest handler via ref, reconstruct with frontmatter)
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            try {
              const contentOnly = update.state.doc.toString();
              const fullDoc = reconstructDocument(frontmatterRef.current, contentOnly);
              onChangeRef.current(fullDoc);
            } catch (e) {
              console.error(e);
            }
          }
        }),

        // 3. Visual Styling (Minimalist Theme)
        EditorView.theme(
          {
            '&': { height: '100%', fontSize: '16px' },
            '.cm-scroller': { fontFamily: "Menlo, Monaco, 'Courier New', monospace" },
            '.cm-content': {
              caretColor: '#569cd6',
              maxWidth: '800px',
              margin: '0 auto',
              padding: '40px'
            },
            '&.cm-focused': { outline: 'none' }
          },
          { dark: true }
        ),
        // Wiki link plugin and click handler
        wikiLinkPlugin,
        imagePreviewPlugin,
        EditorView.domEventHandlers({
          paste: (event, view) => {
            const items = event.clipboardData?.items;
            if (!items) return false;

            for (const item of items) {
              if (item.type.startsWith('image/')) {
                event.preventDefault();

                const file = item.getAsFile();
                if (!file) return true;

                // Read file as ArrayBuffer and save via IPC
                file.arrayBuffer().then(async (buffer) => {
                  try {
                    const filename = await window.phosphor.saveAsset(buffer, file.name);
                    const text = `![[${filename}]]`;
                    view.dispatch(view.state.replaceSelection(text));
                  } catch (err) {
                    console.error('Failed to save asset:', err);
                  }
                });

                return true;
              }
            }
            return false;
          },
          drop: (event, view) => {
            const files = event.dataTransfer?.files;
            if (!files) return false;

            for (const file of files) {
              if (file.type.startsWith('image/')) {
                event.preventDefault();

                // Get drop position
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null) return true;

                file.arrayBuffer().then(async (buffer) => {
                  try {
                    const filename = await window.phosphor.saveAsset(buffer, file.name);
                    const text = `![[${filename}]]`;
                    view.dispatch({
                      changes: {
                        from: pos,
                        insert: text
                      }
                    });
                  } catch (err) {
                    console.error('Failed to save asset:', err);
                  }
                });

                return true;
              }
            }
            return false;
          },
          click: (event) => {
            try {
              const target = event.target as HTMLElement | null;

              // Handle wiki link clicks
              const linkEl =
                target?.closest && (target.closest('.cm-wiki-link') as HTMLElement | null);
              if (linkEl) {
                const linkTarget = linkEl.getAttribute('data-link-target') || undefined;
                console.debug('Wiki link clicked:', linkTarget);
                if (linkTarget && typeof onLinkClickRef.current === 'function') {
                  event.preventDefault();
                  onLinkClickRef.current(linkTarget);
                  return true;
                }
              }
            } catch (err) {
              console.error('Error handling click', err);
            }
            return false;
          }
        })
      ]
    });

    // 4. Create the View
    const view = new EditorView({
      state: startState,
      parent: editorRef.current
    });

    viewRef.current = view;

    // Enable spell checking on CodeMirror's content element
    const contentEl = view.contentDOM;
    if (contentEl) {
      contentEl.spellcheck = true;
    }

    // Cleanup on unmount
    return () => {
      view.destroy();
    };
  }, [content]); // Re-create editor when content changes

  // Handle external updates (e.g. clicking a different file in sidebar)
  useEffect(() => {
    if (viewRef.current && content !== viewRef.current.state.doc.toString()) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: content
        }
      });
    }
  }, [content]);

  return (
    <div
      ref={editorRef}
      style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      className="editor-container"
      spellCheck="true"
    />
  );
};

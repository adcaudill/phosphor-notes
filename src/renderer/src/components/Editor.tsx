import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { wikiLinkPlugin } from '../editor/extensions/wikiLinks';

interface EditorProps {
  initialDoc: string;
  onChange: (doc: string) => void;
  onLinkClick?: (link: string) => void;
}

export const Editor: React.FC<EditorProps> = ({ initialDoc, onChange, onLinkClick }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onLinkClickRef = useRef(onLinkClick);

  // Keep refs up-to-date so CodeMirror listeners call the latest handlers
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  useEffect(() => {
    if (!editorRef.current) return;

    // 1. Define the Initial State
    const startState = EditorState.create({
      doc: initialDoc,
      extensions: [
        keymap.of([...defaultKeymap, ...historyKeymap]), // Cmd+Z, Enter, etc.
        EditorView.lineWrapping, // Soft wrap long lines
        markdown(), // Markdown syntax support
        history(), // Undo/Redo stack
        syntaxHighlighting(defaultHighlightStyle), // Colors

        // 2. Listener for changes (call latest handler via ref)
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            try {
              onChangeRef.current(update.state.doc.toString());
            } catch (e) {
              console.error(e);
            }
          }
        }),

        // 3. Visual Styling (Minimalist Theme)
        EditorView.theme({
          '&': { height: '100%', fontSize: '16px' },
          '.cm-scroller': { fontFamily: "Menlo, Monaco, 'Courier New', monospace" },
          '.cm-content': {
            caretColor: '#569cd6',
            maxWidth: '800px',
            margin: '0 auto',
            padding: '40px'
          },
          '&.cm-focused': { outline: 'none' }
        }),
        // Wiki link plugin and click handler
        wikiLinkPlugin,
        EditorView.domEventHandlers({
          click: (event) => {
            try {
              const target = event.target as HTMLElement | null;
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
              console.error('Error handling wiki link click', err);
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

    // Cleanup on unmount
    return () => {
      view.destroy();
    };
  }, []); // Run once on mount

  // Handle external updates (e.g. clicking a different file in sidebar)
  useEffect(() => {
    if (viewRef.current && initialDoc !== viewRef.current.state.doc.toString()) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: initialDoc
        }
      });
    }
  }, [initialDoc]);

  return (
    <div
      ref={editorRef}
      style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      className="editor-container"
    />
  );
};

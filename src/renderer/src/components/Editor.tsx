import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineWrapping } from '@codemirror/view';
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
  const viewRef = useRef<EditorView>();

  useEffect(() => {
    if (!editorRef.current) return;

    // 1. Define the Initial State
    const startState = EditorState.create({
      doc: initialDoc,
      extensions: [
        keymap.of([...defaultKeymap, ...historyKeymap]), // Cmd+Z, Enter, etc.
        lineWrapping, // Soft wrap long lines
        markdown(), // Markdown syntax support
        history(), // Undo/Redo stack
        syntaxHighlighting(defaultHighlightStyle), // Colors

        // 2. Listener for changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        }),

        // 3. Visual Styling (Minimalist Theme)
        EditorView.theme({
          "&": { height: "100%", fontSize: "16px" },
          ".cm-scroller": { fontFamily: "Menlo, Monaco, 'Courier New', monospace" },
          ".cm-content": { caretColor: "#569cd6", maxWidth: "800px", margin: "0 auto", padding: "40px" },
          "&.cm-focused": { outline: "none" }
        })
        ,
        // Wiki link plugin and click handler
        wikiLinkPlugin,
        EditorView.domEventHandlers({
          mousedown: (event) => {
            const target = event.target as HTMLElement;
            if (target && target.matches && target.matches('.cm-wiki-link')) {
              const linkTarget = target.getAttribute('data-link-target') || undefined;
              if (linkTarget && typeof onLinkClick === 'function') {
                event.preventDefault();
                onLinkClick(linkTarget);
                return true;
              }
            }
            return false;
          }
        })
      ],
    });

    // 4. Create the View
    const view = new EditorView({
      state: startState,
      parent: editorRef.current,
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

  return <div ref={editorRef} style={{ height: '100vh', overflow: 'hidden' }} />;
};
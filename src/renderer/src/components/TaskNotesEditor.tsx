/**
 * The notes editor in the task detail view: a small CodeMirror instance with
 * the main editor's Markdown look and wiki-link styling, saving after a pause
 * in typing and when it loses focus.
 */
import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { wikiLinkPlugin } from '../editor/extensions/wikiLinks';

const SAVE_DELAY_MS = 700;

export function TaskNotesEditor({
  value,
  onSave
}: {
  value: string;
  onSave: (notes: string) => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveRef = useRef(onSave);
  const lastSaved = useRef(value);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const flush = (): void => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      const text = viewRef.current?.state.doc.toString() ?? lastSaved.current;
      if (text !== lastSaved.current) {
        lastSaved.current = text;
        saveRef.current(text);
      }
    };
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          wikiLinkPlugin,
          EditorView.lineWrapping,
          placeholder('Notes - Markdown, [[links]] welcome'),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
          }),
          EditorView.domEventHandlers({ blur: () => flush() })
        ]
      })
    });
    viewRef.current = view;
    return () => {
      flush();
      view.destroy();
      viewRef.current = null;
    };
    // Created once per task; later saves from elsewhere are picked up below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notes changed outside this editor (another window, MCP): take them, unless mid-edit.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.hasFocus || value === view.state.doc.toString()) return;
    lastSaved.current = value;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div className="task-detail-notes-editor" ref={hostRef} />;
}

import React, { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'

interface EditorProps {
  initialContent: string
  onContentChange: (content: string) => void
}

const Editor: React.FC<EditorProps> = ({ initialContent, onContentChange }) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (editorRef.current && !editorViewRef.current) {
      const state = EditorState.create({
        doc: initialContent,
        extensions: [
          lineNumbers(),
          markdown(),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': {
              fontFamily: 'Menlo, SFMono-Regular, Consolas, Liberation Mono, monospace',
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onContentChange(update.state.doc.toString())
            }
          })
        ]
      })

      const view = new EditorView({
        state,
        parent: editorRef.current
      })

      editorViewRef.current = view
    }

    return () => {
      if (editorViewRef.current) {
        editorViewRef.current.destroy()
        editorViewRef.current = null
      }
    }
  }, [initialContent, onContentChange])

  return <div ref={editorRef} />
}

export default Editor

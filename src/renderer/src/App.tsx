import React, { useState, useEffect, useRef } from 'react'
import { Editor } from './components/Editor'
import { Sidebar } from './components/Sidebar'

function App(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<string | null>(null)
  const debounceTimer = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const init = async (): Promise<void> => {
      const selectedVault = await window.phosphor.selectVault()
      if (selectedVault) {
        setVaultName(selectedVault)
        const dailyNoteFilename = await window.phosphor.getDailyNoteFilename()
        setCurrentFile(dailyNoteFilename)
        const noteContent = await window.phosphor.readNote(dailyNoteFilename)
        setContent(noteContent)
      } else {
        console.log('No vault selected')
      }
    }
    init()
  }, [])

  const handleContentChange = (newContent: string): void => {
    setContent(newContent)
    if (currentFile) {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
      debounceTimer.current = setTimeout(() => {
        if (currentFile) {
          window.phosphor.saveNote(currentFile, newContent)
        }
      }, 500)
    }
  }

  const handleFileSelect = async (filename: string) => {
    const noteContent = await window.phosphor.readNote(filename);
    setContent(noteContent);
    setCurrentFile(filename);
  }

  return (
    <div className="app-container">
      {vaultName ? (
        <>
          <Sidebar onFileSelect={handleFileSelect} activeFile={currentFile} />
          <main className="main-content">
            <Editor initialDoc={content} onChange={handleContentChange} />
          </main>
        </>
      ) : (
        <div className="welcome-screen">
          <h1>Select a Phosphor Vault to begin.</h1>
        </div>
      )}
    </div>
  )
}

export default App
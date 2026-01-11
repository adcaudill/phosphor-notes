import React, { useState, useEffect, useRef } from 'react'
import { Editor } from './components/Editor'
import { Sidebar } from './components/Sidebar'

function App(): React.JSX.Element {
  const [content, setContent] = useState('')
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [currentFile, setCurrentFile] = useState<string | null>(null)
  const [filesVersion, setFilesVersion] = useState<number>(0)
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

  const handleLinkClick = async (linkText: string) => {
    const filename = linkText.endsWith('.md') ? linkText : `${linkText}.md`;
    // readNote will create the file if missing (per main IPC behavior)
    const content = await window.phosphor.readNote(filename);
    setCurrentFile(filename);
    setContent(content);
    // Trigger a save to ensure it appears in sidebar immediately
    await window.phosphor.saveNote(filename, content);
    // Bump filesVersion so Sidebar re-fetches
    setFilesVersion(v => v + 1);
  }

  return (
    <div className="app-container">
      {vaultName ? (
        <>
          <Sidebar onFileSelect={handleFileSelect} activeFile={currentFile} refreshSignal={filesVersion} />
          <main className="main-content">
            <Editor initialDoc={content} onChange={handleContentChange} onLinkClick={handleLinkClick} />
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
import React, { useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import '../styles/SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { settings, updateSetting } = useSettings();
  const [activeTab, setActiveTab] = useState<'editor' | 'appearance' | 'grammar' | 'keybindings'>(
    'editor'
  );

  if (!isOpen) return null;

  // Detect system preference if theme is set to "system"
  let effectiveTheme = settings.theme;
  if (settings.theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    effectiveTheme = prefersDark ? 'dark' : 'light';
  }

  const themeClass = `theme-${effectiveTheme}`;

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className={`settings-modal-content ${themeClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h1>Preferences</h1>
          <button className="settings-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-container">
          <div className="settings-sidebar">
            <button
              className={`settings-tab ${activeTab === 'editor' ? 'active' : ''}`}
              onClick={() => setActiveTab('editor')}
            >
              Editor
            </button>
            <button
              className={`settings-tab ${activeTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              Appearance
            </button>
            <button
              className={`settings-tab ${activeTab === 'grammar' ? 'active' : ''}`}
              onClick={() => setActiveTab('grammar')}
            >
              Grammar & Style
            </button>
            <button
              className={`settings-tab ${activeTab === 'keybindings' ? 'active' : ''}`}
              onClick={() => setActiveTab('keybindings')}
            >
              Key Bindings
            </button>
          </div>

          <div className="settings-content">
            {activeTab === 'editor' && (
              <>
                <h2>Editor Settings</h2>

                <div className="setting-item">
                  <label htmlFor="font-size">Font Size</label>
                  <div className="setting-value-group">
                    <input
                      id="font-size"
                      type="number"
                      min="10"
                      max="32"
                      value={settings.editorFontSize}
                      onChange={(e) => updateSetting('editorFontSize', Number(e.target.value))}
                    />
                    <span className="setting-unit">px</span>
                  </div>
                </div>

                <div className="setting-item">
                  <label htmlFor="line-height">Line Height</label>
                  <div className="setting-value-group">
                    <input
                      id="line-height"
                      type="number"
                      min="1"
                      max="2"
                      step="0.1"
                      value={settings.lineHeight}
                      onChange={(e) => updateSetting('lineHeight', Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="show-line-numbers">
                    <input
                      id="show-line-numbers"
                      type="checkbox"
                      checked={settings.showLineNumbers}
                      onChange={(e) => updateSetting('showLineNumbers', e.target.checked)}
                    />
                    Show Line Numbers
                  </label>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="vim-mode">
                    <input
                      id="vim-mode"
                      type="checkbox"
                      checked={settings.vimMode}
                      onChange={(e) => updateSetting('vimMode', e.target.checked)}
                    />
                    Vim Keybindings
                  </label>
                  <p className="setting-hint">For the power users. Requires editor reload.</p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="typewriter-scrolling">
                    <input
                      id="typewriter-scrolling"
                      type="checkbox"
                      checked={settings.enableTypewriterScrolling}
                      onChange={(e) => updateSetting('enableTypewriterScrolling', e.target.checked)}
                    />
                    Typewriter Scrolling
                  </label>
                  <p className="setting-hint">Keeps cursor centered as you type.</p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="paragraph-dimming">
                    <input
                      id="paragraph-dimming"
                      type="checkbox"
                      checked={settings.enableParagraphDimming}
                      onChange={(e) => updateSetting('enableParagraphDimming', e.target.checked)}
                    />
                    Paragraph Dimming
                  </label>
                  <p className="setting-hint">Dims inactive paragraphs for focus.</p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="smart-typography">
                    <input
                      id="smart-typography"
                      type="checkbox"
                      checked={settings.enableSmartTypography}
                      onChange={(e) => updateSetting('enableSmartTypography', e.target.checked)}
                    />
                    Smart Quotes & Symbols
                  </label>
                  <p className="setting-hint">
                    Converts straight quotes, triple dots, dashes, and common marks like (c) or (tm)
                    into typographic symbols.
                  </p>
                </div>

                <div className="setting-item">
                  <label htmlFor="default-journal-mode">Default Journal Mode</label>
                  <select
                    id="default-journal-mode"
                    value={settings.defaultJournalMode}
                    onChange={(e) =>
                      updateSetting('defaultJournalMode', e.target.value as 'freeform' | 'outliner')
                    }
                  >
                    <option value="freeform">Freeform</option>
                    <option value="outliner">Outliner (Bulleted)</option>
                  </select>
                  <p className="setting-hint">Controls the default format for new daily notes.</p>
                </div>
              </>
            )}

            {activeTab === 'appearance' && (
              <>
                <h2>Appearance</h2>

                <div className="setting-item">
                  <label htmlFor="theme">Theme</label>
                  <select
                    id="theme"
                    value={settings.theme}
                    onChange={(e) =>
                      updateSetting('theme', e.target.value as 'system' | 'light' | 'dark')
                    }
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>

                <div className="setting-item">
                  <label htmlFor="color-palette">Color Palette</label>
                  <select
                    id="color-palette"
                    value={settings.colorPalette}
                    onChange={(e) =>
                      updateSetting('colorPalette', e.target.value as 'snow' | 'amber' | 'green')
                    }
                  >
                    <option value="snow">Snow (Default)</option>
                    <option value="amber">Amber</option>
                    <option value="green">Green</option>
                  </select>
                </div>
              </>
            )}

            {activeTab === 'grammar' && (
              <>
                <h2>Grammar & Style</h2>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-passive-voice">
                    <input
                      id="check-passive-voice"
                      type="checkbox"
                      checked={settings.checkPassiveVoice}
                      onChange={(e) => updateSetting('checkPassiveVoice', e.target.checked)}
                    />
                    Detect Passive Voice
                  </label>
                  <p className="setting-hint">
                    Suggests converting passive sentences to active voice for clarity.
                  </p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-simplification">
                    <input
                      id="check-simplification"
                      type="checkbox"
                      checked={settings.checkSimplification}
                      onChange={(e) => updateSetting('checkSimplification', e.target.checked)}
                    />
                    Suggest Simplifications
                  </label>
                  <p className="setting-hint">
                    Offers simpler alternatives to complex words and phrases.
                  </p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-inclusive-language">
                    <input
                      id="check-inclusive-language"
                      type="checkbox"
                      checked={settings.checkInclusiveLanguage}
                      onChange={(e) => updateSetting('checkInclusiveLanguage', e.target.checked)}
                    />
                    Check Inclusive Language
                  </label>
                  <p className="setting-hint">
                    Detects potentially exclusionary or gendered language.
                  </p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-readability">
                    <input
                      id="check-readability"
                      type="checkbox"
                      checked={settings.checkReadability}
                      onChange={(e) => updateSetting('checkReadability', e.target.checked)}
                    />
                    Check Readability
                  </label>
                  <p className="setting-hint">
                    Flags overly complex sentences and readability issues.
                  </p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-profanities">
                    <input
                      id="check-profanities"
                      type="checkbox"
                      checked={settings.checkProfanities}
                      onChange={(e) => updateSetting('checkProfanities', e.target.checked)}
                    />
                    Check for Profanities
                  </label>
                  <p className="setting-hint">Detects profane, vulgar, or offensive language.</p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-cliches">
                    <input
                      id="check-cliches"
                      type="checkbox"
                      checked={settings.checkCliches}
                      onChange={(e) => updateSetting('checkCliches', e.target.checked)}
                    />
                    Flag Cliches
                  </label>
                  <p className="setting-hint">Highlights cliched phrases so you can rephrase.</p>
                </div>

                <div className="setting-item setting-checkbox">
                  <label htmlFor="check-intensify">
                    <input
                      id="check-intensify"
                      type="checkbox"
                      checked={settings.checkIntensify}
                      onChange={(e) => updateSetting('checkIntensify', e.target.checked)}
                    />
                    Detect Weak & Weasel Words
                  </label>
                  <p className="setting-hint">
                    Identifies vague, hedging, or weak language that weakens writing.
                  </p>
                </div>
              </>
            )}

            {activeTab === 'keybindings' && (
              <>
                <h2>Key Bindings</h2>

                <p className="setting-hint">Read-only list of the app&apos;s primary shortcuts.</p>

                <div className="setting-item keybindings-list">
                  {[
                    { action: 'Open Settings / Preferences', keys: 'Cmd+, (mac) / Ctrl+,' },
                    { action: 'New Note', keys: 'Cmd+N / Ctrl+N' },
                    { action: 'Save', keys: 'Cmd+S / Ctrl+S' },
                    { action: 'Open Vault…', keys: 'Cmd+O / Ctrl+O' },
                    { action: 'Lock Vault', keys: 'Cmd+L / Ctrl+L' },
                    { action: 'Search / Command Palette', keys: 'Cmd+K / Ctrl+K' },
                    { action: 'Toggle Sidebar', keys: 'Cmd+\\ / Ctrl+\\' },
                    { action: 'Focus Mode', keys: 'Cmd+D / Ctrl+D' },
                    { action: 'Paragraph Dimming', keys: 'Cmd+Option+F / Ctrl+Alt+F' },
                    { action: 'Toggle Developer Tools', keys: 'Cmd+Option+I / Ctrl+Shift+I' },
                    { action: 'Close Window', keys: 'Cmd+W / Ctrl+W' },
                    { action: 'Quit (mac)', keys: 'Cmd+Q' },
                    { action: 'Editor — Cycle Task Status', keys: 'Mod+Enter' },
                    { action: 'Editor — Undo', keys: 'Mod+Z' },
                    { action: 'Editor — Redo', keys: 'Mod+Shift+Z or Mod+Y' }
                  ].map((kb) => (
                    <div key={kb.action} className="keybinding-item">
                      <div className="keybinding-action">{kb.action}</div>
                      <div className="keybinding-keys">{kb.keys}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

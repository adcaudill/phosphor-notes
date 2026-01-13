import React, { useState } from 'react';
import { useSettings } from '../hooks/useSettings';
import '../styles/SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { settings, updateSetting } = useSettings();
  const [activeTab, setActiveTab] = useState<'editor' | 'appearance' | 'grammar'>('editor');

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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

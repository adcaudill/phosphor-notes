import React, { useState, useEffect, ReactNode } from 'react';
import { SettingsContext } from './SettingsContextValue';
import type { UserSettings } from '../../../types/phosphor.d';

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load settings on mount
  useEffect((): void => {
    const loadSettings = async (): Promise<void> => {
      try {
        const loaded = await window.phosphor.getSettings();
        setSettings(loaded);
      } catch (err) {
        console.error('Failed to load settings:', err);
        // Use defaults on error
        setSettings({
          theme: 'system',
          colorPalette: 'snow',
          editorFontSize: 16,
          vimMode: false,
          showLineNumbers: false,
          lineHeight: 1.5,
          defaultJournalMode: 'freeform',
          enableTypewriterScrolling: true,
          enableParagraphDimming: false,
          checkPassiveVoice: true,
          checkSimplification: true,
          checkInclusiveLanguage: true,
          checkReadability: true,
          checkProfanities: true,
          checkCliches: false,
          checkIntensify: false
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadSettings();
  }, []);

  const updateSetting = async <K extends keyof UserSettings>(
    key: K,
    value: UserSettings[K]
  ): Promise<void> => {
    try {
      const updated = await window.phosphor.setSetting(key, value);
      setSettings(updated);
    } catch (err) {
      console.error(`Failed to update setting ${String(key)}:`, err);
    }
  };

  const updateSettings = async (updates: Partial<UserSettings>): Promise<void> => {
    try {
      const updated = await window.phosphor.setMultipleSettings(updates);
      setSettings(updated);
    } catch (err) {
      console.error('Failed to update settings:', err);
    }
  };

  if (isLoading || !settings) {
    return (
      <div>
        <div>Loading settings...</div>
      </div>
    );
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};

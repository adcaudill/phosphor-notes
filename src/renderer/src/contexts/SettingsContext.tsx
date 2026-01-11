import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { UserSettings } from '../../../types/phosphor.d';

interface SettingsContextType {
  settings: UserSettings;
  updateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => Promise<void>;
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

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
          editorFontSize: 16,
          vimMode: false,
          showLineNumbers: false,
          lineHeight: 1.5
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
    return <div>Loading settings...</div>;
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};

// Export useSettings as a separate exported function
export function useSettings(): SettingsContextType {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within SettingsProvider');
  }
  return context;
}

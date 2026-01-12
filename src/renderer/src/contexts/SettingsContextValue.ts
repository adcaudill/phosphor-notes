import { createContext } from 'react';
import type { UserSettings } from '../../../types/phosphor.d';

export interface SettingsContextType {
  settings: UserSettings;
  updateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => Promise<void>;
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

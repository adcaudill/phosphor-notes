// Shared types between main and renderer
export interface UserSettings {
  theme: 'system' | 'light' | 'dark';
  colorPalette: 'snow' | 'amber' | 'green';
  editorFontSize: number;
  vimMode: boolean;
  showLineNumbers: boolean;
  lineHeight: number;
  defaultJournalMode: 'freeform' | 'outliner';
  enableTypewriterScrolling: boolean;
  enableParagraphDimming: boolean;
  enableSmartTypography: boolean;
  // Grammar & Style settings
  checkPassiveVoice: boolean;
  checkSimplification: boolean;
  checkInclusiveLanguage: boolean;
  checkReadability: boolean;
  checkProfanities: boolean;
  checkCliches: boolean;
  checkIntensify: boolean;
  // Holiday settings
  holidayCountry: string;
  // Optional persisted window bounds from the last session
  windowBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
}

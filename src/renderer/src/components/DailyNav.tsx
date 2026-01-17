import React from 'react';
import {
  extractFrontmatter,
  extractDateFromFilename,
  isDailyNote
} from '../utils/frontmatterUtils';

interface Props {
  currentFile: string | null;
  content: string;
  onOpenFile: (filename: string) => void;
}

function formatFilenameFromDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}.md`;
}

function addDays(d: Date, days: number): Date {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + days);
  return nd;
}

export default function DailyNav({
  currentFile,
  content,
  onOpenFile
}: Props): React.JSX.Element | null {
  if (!currentFile) return null;

  const { frontmatter } = extractFrontmatter(content);
  const isDailyByFrontmatter = !!frontmatter && String(frontmatter.content?.type) === 'daily';
  const isDailyByFilename = isDailyNote(currentFile);

  if (!isDailyByFrontmatter && !isDailyByFilename) return null;

  const date = extractDateFromFilename(currentFile);
  if (!date) return null; // can't compute prev/next without a date

  const yesterday = addDays(date, -1);
  const tomorrow = addDays(date, 1);

  const yesterdayFile = formatFilenameFromDate(yesterday);
  const tomorrowFile = formatFilenameFromDate(tomorrow);

  return (
    <div
      className="daily-nav"
      style={{ display: 'flex', gap: 8, padding: '6px 12px', alignItems: 'center' }}
    >
      <button
        className="daily-nav-btn"
        onClick={() => onOpenFile(yesterdayFile)}
        title={`Open ${yesterdayFile}`}
      >
        ← Previous Day
      </button>
      <div style={{ flex: 1 }} />
      <button
        className="daily-nav-btn"
        onClick={() => onOpenFile(tomorrowFile)}
        title={`Open ${tomorrowFile}`}
      >
        Next Day →
      </button>
    </div>
  );
}

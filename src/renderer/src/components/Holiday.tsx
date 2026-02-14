import React, { useMemo } from 'react';
import Holidays from 'date-holidays';
import {
  extractFrontmatter,
  isDailyNote,
  extractDateFromFilename
} from '../utils/frontmatterUtils';
import { useSettings } from '../hooks/useSettings';
import '../styles/Holiday.css';

interface Props {
  currentFile: string | null;
  content: string;
}

interface Holiday {
  name: string;
  type: string;
}

function getHolidaysForDate(date: Date, countryCode: string): Holiday[] {
  try {
    const hd = new Holidays(countryCode);
    const holidays = hd.getHolidays(date.getFullYear());

    // Format the date using local components (not ISO string, which converts to UTC)
    // This avoids timezone offset issues
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const targetDate = `${year}-${month}-${day}`;

    // Filter holidays for this specific date
    // Note: holiday.date may include time ("YYYY-MM-DD HH:mm:ss"), so extract just the date part
    const holidaysForDate = holidays.filter(
      (holiday: { date: string; name: string; type: string }) => {
        const holidayDateOnly = holiday.date.split(' ')[0]; // Extract just "YYYY-MM-DD" part
        return holidayDateOnly === targetDate;
      }
    );

    return holidaysForDate.map((holiday: { name: string; type: string }) => ({
      name: holiday.name,
      type: holiday.type
    }));
  } catch (err) {
    console.error(`Failed to get holidays for country ${countryCode}:`, err);
    return [];
  }
}

export default function Holiday({ currentFile, content }: Props): React.JSX.Element | null {
  const { settings } = useSettings();

  const holidays = useMemo(() => {
    if (!currentFile || !settings) return null;

    const { frontmatter } = extractFrontmatter(content);
    const isDailyByFrontmatter = !!frontmatter && String(frontmatter.content?.type) === 'daily';
    const isDailyByFilename = isDailyNote(currentFile);

    if (!isDailyByFrontmatter && !isDailyByFilename) return null;

    const date = extractDateFromFilename(currentFile);
    if (!date) return null;

    const countryCode = settings.holidayCountry || 'US';
    const holidaysForDate = getHolidaysForDate(date, countryCode);
    return holidaysForDate.length > 0 ? holidaysForDate : null;
  }, [currentFile, content, settings]);

  if (!holidays || holidays.length === 0) return null;

  return (
    <div className="holiday-header">
      <div className="holiday-icon">
        <span className="material-symbols-outlined">celebration</span>
      </div>
      <div className="holiday-content">
        {holidays.map((holiday, index) => (
          <div key={index} className="holiday-item">
            <div className="holiday-name">{holiday.name}</div>
            <div className="holiday-type">{holiday.type}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

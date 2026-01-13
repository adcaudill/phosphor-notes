import { describe, it, expect } from 'vitest';
import * as parser from '../taskParser';

describe('taskParser additional edge cases', () => {
  it('parses SCHEDULED org-style dates into scheduledDate', () => {
    const raw = 'Prepare report SCHEDULED: <2026-02-03>';
    const meta = parser.parseTaskMetadata(raw);
    expect(meta.scheduledDate).not.toBeNull();
    expect(parser.formatDate(meta.scheduledDate as Date)).toBe('2026-02-03');
    // cleanText should include original text minus the scheduled token
    expect(meta.cleanText).toContain('Prepare report');
  });

  it('addInterval handles weeks and returns unchanged for invalid interval', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const plus2w = parser.addInterval(d, '+2w');
    expect(parser.formatDate(plus2w)).toBe('2026-01-15');

    const unchanged = parser.addInterval(d, 'not-an-interval');
    expect(unchanged.getTime()).toBe(d.getTime());
  });
});

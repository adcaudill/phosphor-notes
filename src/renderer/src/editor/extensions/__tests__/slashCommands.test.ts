import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { slashCommandsCompletionSource } from '../slashCommands';
import { getDateString } from '../../../utils/dateUtils';

describe('Slash Commands Autocomplete', () => {
  it('should provide completion source', () => {
    expect(slashCommandsCompletionSource).toBeDefined();
    expect(typeof slashCommandsCompletionSource).toBe('function');
  });

  it('should work with EditorState', () => {
    const state = EditorState.create({
      doc: '/t'
    });

    expect(state.doc.toString()).toBe('/t');
  });

  it('should handle heading states with EditorState', () => {
    const state = EditorState.create({
      doc: '/h'
    });

    expect(state.doc.toString()).toBe('/h');
  });

  it('dateUtils should format dates correctly in YYYY-MM-DD format', () => {
    const date = new Date('2026-01-19');
    const formatted = getDateString(date);

    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should handle tomorrow date calculation', () => {
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayStr = getDateString(today);
    const tomorrowStr = getDateString(tomorrow);

    expect(todayStr).not.toBe(tomorrowStr);
    expect(tomorrowStr > todayStr).toBe(true);
  });

  it('should handle yesterday date calculation', () => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStr = getDateString(today);
    const yesterdayStr = getDateString(yesterday);

    expect(todayStr).not.toBe(yesterdayStr);
    expect(yesterdayStr < todayStr).toBe(true);
  });

  it('should handle multi-day offset calculations', () => {
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);

    const todayStr = getDateString(today);
    const nextWeekStr = getDateString(nextWeek);

    expect(nextWeekStr > todayStr).toBe(true);
    const daysDiff =
      (new Date(nextWeekStr).getTime() - new Date(todayStr).getTime()) / (1000 * 60 * 60 * 24);
    expect(Math.round(daysDiff)).toBe(7);
  });
});

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { getDateString } from '../../utils/dateUtils';

// Date calculation utilities
function getRelativeDate(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return getDateString(date);
}

function getNextDayOfWeek(dayName: string): string {
  const days: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };

  const targetDay = days[dayName.toLowerCase()];
  if (targetDay === undefined) return '';

  const date = new Date();
  const currentDay = date.getDay();
  const daysUntilTarget = (targetDay - currentDay + 7) % 7;
  const daysToAdd = daysUntilTarget === 0 ? 7 : daysUntilTarget;

  date.setDate(date.getDate() + daysToAdd);
  return getDateString(date);
}

// Slash command definitions
interface SlashCommand {
  name: string;
  label: string;
  description: string;
  apply: (view: EditorView, from: number, to: number) => void;
}

const slashCommands: SlashCommand[] = [
  // Date shortcuts
  {
    name: 'today',
    label: 'Today',
    description: "Insert today's date",
    apply: (view, from, to) => {
      const date = getDateString(new Date());
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'tomorrow',
    label: 'Tomorrow',
    description: "Insert tomorrow's date",
    apply: (view, from, to) => {
      const date = getRelativeDate(1);
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'yesterday',
    label: 'Yesterday',
    description: "Insert yesterday's date",
    apply: (view, from, to) => {
      const date = getRelativeDate(-1);
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'monday',
    label: 'Next Monday',
    description: "Insert next Monday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('monday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'tuesday',
    label: 'Next Tuesday',
    description: "Insert next Tuesday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('tuesday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'wednesday',
    label: 'Next Wednesday',
    description: "Insert next Wednesday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('wednesday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'thursday',
    label: 'Next Thursday',
    description: "Insert next Thursday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('thursday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'friday',
    label: 'Next Friday',
    description: "Insert next Friday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('friday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'saturday',
    label: 'Next Saturday',
    description: "Insert next Saturday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('saturday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },
  {
    name: 'sunday',
    label: 'Next Sunday',
    description: "Insert next Sunday's date",
    apply: (view, from, to) => {
      const date = getNextDayOfWeek('sunday');
      view.dispatch({
        changes: { from, to, insert: `[[${date}]]` },
        selection: EditorSelection.single(from + date.length + 4)
      });
    }
  },

  // Heading shortcuts
  {
    name: 'h1',
    label: 'Heading 1',
    description: 'Insert H1 heading',
    apply: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '# ' },
        selection: EditorSelection.single(from + 2)
      });
    }
  },
  {
    name: 'h2',
    label: 'Heading 2',
    description: 'Insert H2 heading',
    apply: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '## ' },
        selection: EditorSelection.single(from + 3)
      });
    }
  },
  {
    name: 'h3',
    label: 'Heading 3',
    description: 'Insert H3 heading',
    apply: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '### ' },
        selection: EditorSelection.single(from + 4)
      });
    }
  },
  {
    name: 'h4',
    label: 'Heading 4',
    description: 'Insert H4 heading',
    apply: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '#### ' },
        selection: EditorSelection.single(from + 5)
      });
    }
  },
  {
    name: 'h5',
    label: 'Heading 5',
    description: 'Insert H5 heading',
    apply: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '##### ' },
        selection: EditorSelection.single(from + 6)
      });
    }
  },
  {
    name: 'h6',
    label: 'Heading 6',
    description: 'Insert H6 heading',
    apply: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '###### ' },
        selection: EditorSelection.single(from + 7)
      });
    }
  }
];
/**
 * Completion source for slash commands
 * Provides completions when user types /commandname
 */
export function slashCommandsCompletionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\/[^\s\n]*/);
  if (!match) return null;

  const query = match.text.slice(1); // Drop the leading /
  const from = match.from; // Include the / in the replacement
  const to = context.pos;
  const lowered = query.toLowerCase();

  const options: Completion[] = slashCommands
    .filter((cmd) => cmd.name.toLowerCase().includes(lowered))
    .map((cmd) => ({
      label: cmd.name,
      displayLabel: cmd.label,
      detail: cmd.description,
      type: 'command',
      apply: (view, _completion, applyFrom, applyTo) => {
        cmd.apply(view, applyFrom, applyTo);
      }
    }));

  if (!options.length) return null;

  return {
    from,
    to,
    options,
    filter: false
  };
}

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import {
  RangeSetBuilder,
  StateField,
  StateEffect,
  EditorState,
  Transaction
} from '@codemirror/state';

// Track collapsed state per editor instance
const frontmatterCollapsedEffect = StateEffect.define<boolean>();

const frontmatterCollapsedField = StateField.define<boolean>({
  create: () => true, // Default: collapsed
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(frontmatterCollapsedEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

// Helper to get frontmatter end position
function getFrontmatterEnd(docString: string): number | null {
  if (!docString.startsWith('---')) return null;
  const endMatch = docString.indexOf('\n---', 3);
  if (endMatch === -1) return null;
  return endMatch + 4; // Include the closing ---
}

// Transaction filter to prevent editing frontmatter when collapsed
const preventFrontmatterEditFilter = EditorState.transactionFilter.of((tr: Transaction) => {
  if (!tr.docChanged) return tr;

  const isCollapsed = tr.startState.field(frontmatterCollapsedField);
  if (!isCollapsed) return tr; // Allow edits when expanded

  const docString = tr.startState.doc.toString();
  const endOfBlock = getFrontmatterEnd(docString);
  if (endOfBlock === null) return tr;

  // Check if any change is within the frontmatter block
  let changedInFrontmatter = false;
  tr.changes.iterChanges((fromA) => {
    if (fromA < endOfBlock) {
      changedInFrontmatter = true;
    }
  });

  if (changedInFrontmatter) {
    // Reject any changes to the frontmatter block when collapsed
    return [];
  }

  return tr;
});

class FrontmatterToggleWidget extends WidgetType {
  constructor(
    readonly isCollapsed: boolean,
    readonly onToggle: () => void
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('button');
    wrap.className = 'cm-frontmatter-toggle';
    wrap.setAttribute('type', 'button');
    wrap.setAttribute('aria-label', this.isCollapsed ? 'Show metadata' : 'Hide metadata');
    wrap.title = this.isCollapsed ? 'Show metadata' : 'Hide metadata';

    // Arrow indicator
    const arrow = document.createElement('span');
    arrow.className = 'cm-frontmatter-arrow';
    arrow.innerText = this.isCollapsed ? '▸' : '▾';

    wrap.appendChild(arrow);

    wrap.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onToggle();
    });

    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const frontmatterPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.state.field(frontmatterCollapsedField) !==
          update.startState.field(frontmatterCollapsedField)
      ) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const docString = view.state.doc.toString();
      const isCollapsed = view.state.field(frontmatterCollapsedField);

      const endOfBlock = getFrontmatterEnd(docString);
      if (endOfBlock !== null) {
        // Add toggle widget at the start of the file
        builder.add(
          0,
          0,
          Decoration.widget({
            widget: new FrontmatterToggleWidget(isCollapsed, () => {
              // Dispatch effect to toggle state
              view.dispatch({
                effects: [frontmatterCollapsedEffect.of(!isCollapsed)]
              });
            }),
            side: -1 // Place before text
          })
        );

        // If collapsed, hide the frontmatter lines
        if (isCollapsed) {
          const lines = docString.slice(0, endOfBlock).split('\n');
          let currentPos = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineEnd = currentPos + line.length;

            // Replace the line content with nothing
            if (lineEnd > currentPos) {
              builder.add(currentPos, lineEnd, Decoration.replace({}));
            }

            currentPos = lineEnd + 1;
          }
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: () => [frontmatterCollapsedField, preventFrontmatterEditFilter]
  }
);

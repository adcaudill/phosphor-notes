import { Decoration, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, RangeSet } from '@codemirror/state';

const strikeMark = Decoration.mark({ class: 'cm-md-strikethrough' });

const strikethroughPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }
    buildDecorations(view: EditorView): RangeSet<Decoration> {
      const builder = new RangeSetBuilder<Decoration>();
      const regex = /~~([\s\S]*?)~~/g;
      for (const range of view.visibleRanges) {
        const text = view.state.doc.sliceString(range.from, range.to);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const matchStart = range.from + match.index;
          const matchEnd = matchStart + match[0].length;
          const innerStart = matchStart + 2; // exclude the leading ~~
          const innerEnd = matchEnd - 2; // exclude the trailing ~~
          if (innerStart < innerEnd) {
            builder.add(innerStart, innerEnd, strikeMark);
          }
        }
      }
      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

const strikethroughTheme = EditorView.baseTheme({
  '.cm-md-strikethrough': {
    textDecoration: 'line-through',
    textDecorationThickness: '1px',
    color: 'var(--editor-muted)'
  }
});

export const strikethroughExtension = [strikethroughPlugin, strikethroughTheme];

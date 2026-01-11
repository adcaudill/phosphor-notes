import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

class FrontmatterWidget extends WidgetType {
  constructor(readonly rawText: string) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-frontmatter-pill';

    // Parse the frontmatter to extract and count tags
    const lines = this.rawText.split('\n');
    let tagCount = 0;

    for (const line of lines) {
      if (line.match(/tags:\s*\[/)) {
        const matches = line.match(/\w+/g);
        if (matches) {
          // Subtract 'tags' and ']' from the count
          tagCount += matches.length - 1;
        }
      } else if (line.match(/#\w+/)) {
        const matches = line.match(/#\w+/g);
        if (matches) {
          tagCount += matches.length;
        }
      }
    }

    const tagText = tagCount > 0 ? `${tagCount} ${tagCount === 1 ? 'Tag' : 'Tags'}` : 'Metadata';
    wrap.innerText = tagText;

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
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const docString = view.state.doc.toString();

      // Only look at the very start of the file
      if (docString.startsWith('---')) {
        const endMatch = docString.indexOf('\n---', 3);
        if (endMatch !== -1) {
          // We found a valid block
          const endOfBlock = endMatch + 4; // Include the closing ---

          builder.add(
            0,
            endOfBlock,
            Decoration.replace({
              widget: new FrontmatterWidget(docString.slice(0, endOfBlock))
            })
          );
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

class ImageWidget extends WidgetType {
  constructor(readonly filename: string) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-image-widget-wrapper';

    const img = document.createElement('img');
    img.src = `phosphor://${this.filename}`;
    img.className = 'cm-image-widget';
    img.alt = this.filename;

    wrapper.appendChild(img);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const imagePreviewPlugin = ViewPlugin.fromClass(
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

      // Match pattern: ![[filename]]
      const imagePattern = /!\[\[(.*?)\]\]/g;

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match;

        // Reset regex for each range
        imagePattern.lastIndex = 0;

        while ((match = imagePattern.exec(text)) !== null) {
          const start = from + match.index;
          const end = start + match[0].length;
          const filename = match[1];

          // Skip PDFs so they can be handled by the PDF widget
          if (filename.toLowerCase().endsWith('.pdf')) continue;

          builder.add(
            start,
            end,
            Decoration.replace({
              widget: new ImageWidget(filename)
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

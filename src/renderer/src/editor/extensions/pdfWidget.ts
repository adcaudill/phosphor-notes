import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

class PdfWidget extends WidgetType {
  constructor(readonly filename: string) {
    super();
  }

  private buildButton(label: string, className: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    return btn;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-pdf-widget-wrapper';

    const card = document.createElement('div');
    card.className = 'cm-pdf-card';

    const header = document.createElement('div');
    header.className = 'cm-pdf-card__header';

    const icon = document.createElement('div');
    icon.className = 'cm-pdf-icon';
    icon.textContent = 'PDF';

    const titleButton = this.buildButton(this.filename, 'cm-pdf-title');
    titleButton.title = 'Open in default viewer';

    const actions = document.createElement('div');
    actions.className = 'cm-pdf-actions';

    const previewButton = this.buildButton('Preview', 'cm-pdf-btn');
    const openButton = this.buildButton('Open', 'cm-pdf-btn cm-pdf-btn-primary');

    const embedContainer = document.createElement('div');
    embedContainer.className = 'cm-pdf-embed';
    embedContainer.hidden = true;

    const loadEmbed = (): void => {
      if (embedContainer.querySelector('embed')) return;
      const embed = document.createElement('embed');
      // Encode filenames and use an explicit path so reserved characters
      // don't get interpreted as URL authority parts.
      embed.src = `phosphor:///${encodeURIComponent(this.filename)}#toolbar=0&navpanes=0`;
      embed.type = 'application/pdf';
      embed.width = '100%';
      embed.height = '500px';
      embedContainer.appendChild(embed);
    };

    const togglePreview = (): void => {
      const willShow = embedContainer.hidden;
      embedContainer.hidden = !willShow;
      previewButton.textContent = willShow ? 'Hide' : 'Preview';
      if (willShow) {
        loadEmbed();
      }
    };

    const openAsset = async (): Promise<void> => {
      try {
        await window.phosphor.openAsset(this.filename);
      } catch (err) {
        console.error('Failed to open asset', err);
      }
    };

    previewButton.addEventListener('click', togglePreview);
    openButton.addEventListener('click', openAsset);
    titleButton.addEventListener('click', openAsset);

    header.appendChild(icon);
    header.appendChild(titleButton);
    header.appendChild(actions);
    actions.appendChild(previewButton);
    actions.appendChild(openButton);

    card.appendChild(header);
    card.appendChild(embedContainer);
    wrapper.appendChild(card);

    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export const pdfWidgetPlugin = ViewPlugin.fromClass(
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
      const pattern = /!\[\[(.*?)\]\]/g;

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;

        while ((match = pattern.exec(text)) !== null) {
          const filename = match[1];
          if (!filename.toLowerCase().endsWith('.pdf')) continue;

          const start = from + match.index;
          const end = start + match[0].length;

          builder.add(
            start,
            end,
            Decoration.replace({
              widget: new PdfWidget(filename)
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

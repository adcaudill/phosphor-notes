import {
  EditorView,
  PluginValue,
  ViewPlugin,
  Decoration,
  DecorationSet,
  ViewUpdate
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// URL regex pattern - matches http://, https://, ftp://, etc.
const URL_PATTERN = /\b(https?:\/\/|ftp:\/\/)[^\s<>[\]{}|\\^`"]*[^\s<>[\]{}|\\^`".,;:!?-]/g;

// Markdown link pattern - matches [text](url)
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(((https?:\/\/|ftp:\/\/)[^\s)]+)\)/g;

// Create decoration for URLs
const urlDecoration = Decoration.mark({ class: 'cm-url-underline' });

/**
 * Detects URLs in the editor and makes them clickable via Cmd/Ctrl+Click
 * Opens URLs in the default browser
 */
export class URLHandler implements PluginValue {
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
    const builder = new RangeSetBuilder<typeof urlDecoration>();

    // Iterate through the document and find URLs
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);

      // Find standalone URLs
      let match: RegExpExecArray | null;
      while ((match = URL_PATTERN.exec(text)) !== null) {
        const urlStart = from + match.index;
        const urlEnd = urlStart + match[0].length;
        builder.add(urlStart, urlEnd, urlDecoration);
      }

      // Reset regex state
      URL_PATTERN.lastIndex = 0;

      // Find URLs in markdown links [text](url)
      while ((match = MARKDOWN_LINK_PATTERN.exec(text)) !== null) {
        const urlStart = from + match.index + match[1].length + 2; // +2 for "]("
        const urlEnd = urlStart + match[2].length;
        builder.add(urlStart, urlEnd, urlDecoration);
      }

      // Reset regex state
      MARKDOWN_LINK_PATTERN.lastIndex = 0;
    }

    return builder.finish();
  }
}

export const urlPlugin = ViewPlugin.fromClass(URLHandler, {
  decorations: (instance) => instance.decorations
});

/**
 * Detects if text at the given position is a valid URL (standalone or in markdown link)
 */
export function getURLAtPosition(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const posInLine = pos - line.from;

  // First check if we're inside a markdown link
  const markdownMatch = MARKDOWN_LINK_PATTERN.exec(lineText);
  if (markdownMatch) {
    const urlStart = markdownMatch.index + markdownMatch[1].length + 2; // +2 for "]("
    const urlEnd = urlStart + markdownMatch[2].length;
    if (posInLine >= urlStart && posInLine <= urlEnd) {
      return markdownMatch[2];
    }
  }
  MARKDOWN_LINK_PATTERN.lastIndex = 0;

  // Check for standalone URL
  let urlStart = posInLine;
  let urlEnd = posInLine;

  // Find the start of the URL (look backwards for protocol)
  while (urlStart > 0 && lineText[urlStart - 1] && !/[\s[\]()]/.test(lineText[urlStart - 1])) {
    urlStart--;
  }

  // Find the end of the URL
  while (urlEnd < lineText.length && lineText[urlEnd] && !/[\s[\]()]/.test(lineText[urlEnd])) {
    urlEnd++;
  }

  const potentialURL = lineText.substring(urlStart, urlEnd);

  // Validate it's actually a URL
  if (/^(https?:\/\/|ftp:\/\/)/.test(potentialURL)) {
    return potentialURL;
  }

  return null;
}

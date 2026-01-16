import {
  EditorView,
  PluginValue,
  ViewPlugin,
  Decoration,
  DecorationSet,
  ViewUpdate,
  hoverTooltip
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// URL regex pattern - matches http://, https://, ftp://, etc.
const URL_PATTERN = /\b(https?:\/\/|ftp:\/\/)[^\s<>[\]{}|\\^`"]*[^\s<>[\]{}|\\^`".,;:!?-]/g;

// Markdown link pattern - matches [text](url)
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(((https?:\/\/|ftp:\/\/)[^\s)]+)\)/g;

// Create decoration for URLs
const urlDecoration = Decoration.mark({ class: 'cm-url-underline' });

// Tooltip helper function
const urlHoverTooltip = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const posInLine = pos - line.from;

  // Check if position is within a URL (markdown link or standalone)
  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = MARKDOWN_LINK_PATTERN.exec(lineText)) !== null) {
    const urlPosInMatch = markdownMatch[0].indexOf(markdownMatch[2]);
    const urlStart = markdownMatch.index + urlPosInMatch;
    const urlEnd = urlStart + markdownMatch[2].length;
    if (posInLine >= urlStart && posInLine < urlEnd) {
      return {
        pos: urlStart,
        end: urlEnd,
        above: true,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'cm-url-tooltip';
          dom.textContent = '⌘ + Click to open';
          return { dom };
        }
      };
    }
  }
  MARKDOWN_LINK_PATTERN.lastIndex = 0;

  // Check for standalone URL
  let urlStart = posInLine;
  let urlEnd = posInLine;
  while (urlStart > 0 && lineText[urlStart - 1] && !/[\s[\]()]/.test(lineText[urlStart - 1])) {
    urlStart--;
  }
  while (urlEnd < lineText.length && lineText[urlEnd] && !/[\s[\]()]/.test(lineText[urlEnd])) {
    urlEnd++;
  }

  const potentialURL = lineText.substring(urlStart, urlEnd);
  if (/^(https?:\/\/|ftp:\/\/)/.test(potentialURL)) {
    return {
      pos: line.from + urlStart,
      end: line.from + urlEnd,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-url-tooltip';
        dom.textContent = '⌘ + Click to open';
        return { dom };
      }
    };
  }

  return null;
});

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
    const occupied: Array<{ from: number; to: number }> = [];

    // Iterate through the document and find URLs
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);

      // Reset regex state before processing each range
      URL_PATTERN.lastIndex = 0;
      MARKDOWN_LINK_PATTERN.lastIndex = 0;

      // Find URLs in markdown links [text](url) first (more specific pattern)
      let match: RegExpExecArray | null;
      MARKDOWN_LINK_PATTERN.lastIndex = 0;
      while ((match = MARKDOWN_LINK_PATTERN.exec(text)) !== null) {
        // match[0] = entire markdown link: [text](url)
        // match[2] = the URL: url
        // Find where the URL actually starts within the match
        const urlPosInMatch = match[0].indexOf(match[2]);
        const urlStart = from + match.index + urlPosInMatch;
        const urlEnd = urlStart + match[2].length; // exclusive
        occupied.push({ from: urlStart, to: urlEnd });
        builder.add(urlStart, urlEnd, urlDecoration);
      }

      // Find standalone URLs
      URL_PATTERN.lastIndex = 0;
      while ((match = URL_PATTERN.exec(text)) !== null) {
        const urlStart = from + match.index;
        let urlText = match[0];

        // Trim unmatched trailing ')'
        const leftParens = (urlText.match(/\(/g) || []).length;
        let rightParens = (urlText.match(/\)/g) || []).length;
        while (rightParens > leftParens && urlText.endsWith(')')) {
          urlText = urlText.slice(0, -1);
          rightParens -= 1;
        }

        // Trim trailing punctuation that shouldn't be part of URL
        urlText = urlText.replace(/[.,;:!?]+$/g, '');

        const urlEnd = urlStart + urlText.length; // exclusive

        // Skip if this range overlaps a markdown URL we've already decorated
        const overlapsMarkdown = occupied.some((r) => urlStart < r.to && urlEnd > r.from);
        if (overlapsMarkdown) continue;

        builder.add(urlStart, urlEnd, urlDecoration);
      }
    }

    return builder.finish();
  }
}

export const urlPlugin = ViewPlugin.fromClass(URLHandler, {
  decorations: (instance) => instance.decorations
});

// Export both the plugin and the tooltip as an extension
export const urlExtensions = [urlPlugin, urlHoverTooltip];

/**
 * Detects if text at the given position is a valid URL (standalone or in markdown link)
 */
export function getURLAtPosition(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const posInLine = pos - line.from;

  // Reset regex state before matching
  MARKDOWN_LINK_PATTERN.lastIndex = 0;

  // First check if we're inside a markdown link
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = MARKDOWN_LINK_PATTERN.exec(lineText)) !== null) {
    // match[0] = entire markdown link: [text](url)
    // match[2] = the URL: url
    const urlPosInMatch = markdownMatch[0].indexOf(markdownMatch[2]);
    const urlStart = markdownMatch.index + urlPosInMatch;
    const urlEnd = urlStart + markdownMatch[2].length;
    if (posInLine >= urlStart && posInLine < urlEnd) {
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

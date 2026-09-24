import { EditorView } from '@codemirror/view';
import { convertHtmlToMarkdown } from '../../utils/htmlToMarkdown';

const hasAssetFile = (items: DataTransferItemList | undefined): boolean => {
  if (!items) return false;
  return Array.from(items).some((item) => {
    if (item.kind !== 'file') return false;
    return item.type.startsWith('image/') || item.type === 'application/pdf';
  });
};

const isValidUrl = (text: string): boolean => {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
};

const hasSelection = (view: EditorView): boolean => {
  const { from, to } = view.state.selection.main;
  return from !== to;
};

const getCurrentBulletIndent = (view: EditorView): string => {
  const currentLine = view.state.doc.lineAt(view.state.selection.main.from).number;

  for (let lineNumber = currentLine; lineNumber >= 1; lineNumber -= 1) {
    const line = view.state.doc.line(lineNumber);
    const bulletMatch = line.text.match(/^(\s*)-\s/);
    if (bulletMatch) return bulletMatch[1];
  }

  return view.state.doc.line(currentLine).text.match(/^(\s*)/)?.[1] ?? '';
};

const getOutlinerPasteRange = (view: EditorView): { from: number; to: number } => {
  const selection = view.state.selection.main;
  if (selection.from !== selection.to) return { from: selection.from, to: selection.to };

  const line = view.state.doc.lineAt(selection.from);
  if (/^\s*-\s*(?:\[(?: |x|X)\]\s*)?$/.test(line.text)) {
    return { from: line.from, to: line.to };
  }

  return { from: selection.from, to: selection.to };
};

export const normalizeOutlinerPaste = (text: string, baseIndent: string): string => {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] ?? '';
      const content = line.slice(leadingWhitespace.length).replace(/^(?:[-+*]|\d+[.)])\s+/, '');
      return `${baseIndent}${leadingWhitespace}- ${content}`;
    })
    .join('\n');
};

export const shouldNormalizeOutlinerPaste = (text: string): boolean => {
  if (text.includes('\n')) return true;
  return /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(text);
};

export const createSmartPaste = (isOutlinerMode = false) =>
  EditorView.domEventHandlers({
    paste: (event, view) => {
      // If Shift key is held, allow default paste behavior; check safely for shiftKey.
      if ('shiftKey' in event && (event as { shiftKey?: boolean }).shiftKey) return false;

      const clipboard = (event as ClipboardEvent).clipboardData;
      if (!clipboard) return false;

      // Let the asset handler manage pasted files such as images or PDFs.
      if (hasAssetFile(clipboard.items)) return false;

      const text = clipboard.getData('text/plain') || '';

      // Paste URL over Text: If there's a selection and clipboard contains a URL,
      // convert to a markdown link [selectedText](url)
      if (hasSelection(view) && isValidUrl(text)) {
        const selectedText = view.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to
        );
        const markdownLink = `[${selectedText}](${text})`;
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(markdownLink));
        return true;
      }

      const html = clipboard.getData('text/html');
      let pasteText = text;

      if (html) {
        try {
          const markdown = convertHtmlToMarkdown(html);

          // If conversion yields nothing or matches the plain text, keep the plain text.
          if (markdown.trim() && markdown.trim() !== text.trim()) {
            pasteText = markdown;
          }
        } catch (err) {
          console.error('Smart paste conversion failed:', err);
        }
      }

      if (isOutlinerMode && pasteText.trim() && shouldNormalizeOutlinerPaste(pasteText)) {
        event.preventDefault();
        const normalized = normalizeOutlinerPaste(pasteText, getCurrentBulletIndent(view));
        const range = getOutlinerPasteRange(view);
        view.dispatch({ changes: { from: range.from, to: range.to, insert: normalized } });
        return true;
      }

      if (!html) return false;

      event.preventDefault();
      view.dispatch(view.state.replaceSelection(pasteText));
      return true;
    }
  });

export const smartPaste = createSmartPaste();

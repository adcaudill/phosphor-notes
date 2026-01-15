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

export const smartPaste = EditorView.domEventHandlers({
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
    if (!html) return false;

    try {
      const markdown = convertHtmlToMarkdown(html);

      // If conversion yields nothing or matches the plain text, fall back to default.
      if (!markdown.trim() || markdown.trim() === text.trim()) {
        return false;
      }

      event.preventDefault();
      view.dispatch(view.state.replaceSelection(markdown));
      return true;
    } catch (err) {
      console.error('Smart paste failed:', err);
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(text));
      return true;
    }
  }
});

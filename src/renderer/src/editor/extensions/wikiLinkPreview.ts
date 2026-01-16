import { hoverTooltip } from '@codemirror/view';

/**
 * Extract the first 20 lines of markdown content, skipping frontmatter
 */
function getPreviewText(content: string): string {
  const lines = content.split('\n');

  // Skip frontmatter (YAML between --- markers at the start)
  let startIdx = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        startIdx = i + 1;
        break;
      }
    }
  }

  // Get first 20 lines after frontmatter
  const previewLines = lines.slice(startIdx, startIdx + 20);
  return previewLines.join('\n').trim();
}

/**
 * Create a hover tooltip for wiki links showing raw markdown preview
 */
export const wikiLinkHoverTooltip = hoverTooltip((view, pos) => {
  // Check if we're hovering over a wiki link
  const range = view.state.doc;
  const line = range.lineAt(pos);
  const text = line.text;
  const relativePos = pos - line.from;

  // Find wiki link at cursor position
  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
  let match;
  let inLink = false;
  let linkTarget = '';
  let linkStart = 0;
  let linkEnd = 0;

  while ((match = wikiLinkPattern.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    if (relativePos >= matchStart && relativePos < matchEnd) {
      inLink = true;
      linkTarget = match[1];
      linkStart = line.from + matchStart;
      linkEnd = line.from + matchEnd;
      break;
    }
  }

  if (!inLink || !linkTarget) {
    return null;
  }

  return {
    pos: linkStart,
    end: linkEnd,
    above: false,
    create() {
      const container = document.createElement('div');
      container.className = 'cm-wiki-preview-tooltip';

      // Show loading state
      container.innerHTML = '<div class="cm-wiki-preview-loading">Loading...</div>';

      // Fetch the note content (async)
      window.phosphor
        .readNote(`${linkTarget}.md`)
        .then((content: string) => {
          const previewText = getPreviewText(content);
          const displayText = previewText || '(empty)';
          const previewHTML = `
            <div class="cm-wiki-preview-content">
              <div class="cm-wiki-preview-title">${escapeHtml(linkTarget)}</div>
              <pre class="cm-wiki-preview-body">${escapeHtml(displayText)}</pre>
            </div>
          `;
          container.innerHTML = previewHTML;
        })
        .catch(() => {
          container.innerHTML =
            '<div class="cm-wiki-preview-error">File not found: ' +
            escapeHtml(linkTarget) +
            '</div>';
        });

      return { dom: container };
    }
  };
});

/**
 * Simple HTML escape utility
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*'
});

// Enable GitHub Flavored Markdown conversions such as tables and task lists.
turndownService.use(gfm);

// Strip out style and script tags that should never reach the document body.
turndownService.addRule('remove-styles-and-scripts', {
  filter: ['style', 'script', 'meta'],
  replacement: () => ''
});

export const convertHtmlToMarkdown = (html: string): string => turndownService.turndown(html);

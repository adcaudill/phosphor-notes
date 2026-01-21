/**
 * Shared wikilink utilities used across main, worker, and renderer.
 */

/**
 * Extract wikilinks from markdown content.
 * Handles aliases, headings, and attachments appropriately.
 * @param content Markdown file content
 * @returns Array of extracted wikilinks with .md extensions where applicable
 */
export function extractWikilinks(content: string): string[] {
  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const links: string[] = [];

  let match;
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    // If the wikilink is a transclusion/embedded attachment like ![[file.png]], skip it
    const startIndex = match.index;
    if (startIndex > 0 && content[startIndex - 1] === '!') continue;

    let link = match[1].trim();
    if (!link) continue; // Skip empty matches

    // Remove alias or heading parts like 'file|alias' or 'file#heading'
    link = link.split('|')[0].split('#')[0].trim();
    if (!link) continue;

    // Normalize relative path markers
    if (link.startsWith('./')) link = link.slice(2);

    // If link has an extension and it's not .md, treat it as an attachment and skip
    const lastDot = link.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = link.substring(lastDot + 1).toLowerCase();
      if (ext !== 'md') {
        // Attachment (e.g., .png, .jpg, .pdf) - do not add to graph
        continue;
      }
      // already ends with .md - keep as-is
    } else {
      // No extension - assume a markdown file and add .md
      link += '.md';
    }

    // Add the explicit link
    links.push(link);

    // For nested paths, also add implicit parent links
    // e.g., [[People/John.md]] creates implicit links to [[People.md]]
    if (link.includes('/')) {
      const parts = link.split('/');
      // Process each parent level
      for (let i = 1; i < parts.length; i++) {
        const parentPath = parts.slice(0, i).join('/') + '.md';
        links.push(parentPath);
      }
    }
  }

  return links;
}

/**
 * Generate implicit parent links for a given filename.
 *
 * This is used to ensure that nested paths also link to their parent directories.
 * For example, a link to "Projects/ProjectA/Notes.md" will also create implicit
 * links to "Projects.md" and "Projects/ProjectA.md".
 * @param filename The filename or path to analyze
 * @returns Array of implicit parent links for nested paths
 */
export function getImplicitPathLinks(filename: string): string[] {
  const implicitLinks: string[] = [];

  if (filename.includes('/')) {
    const parts = filename.split('/');
    // Create links to each parent level, from shallowest to deepest
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join('/') + '.md';
      implicitLinks.push(parentPath);
    }
  }

  return implicitLinks;
}

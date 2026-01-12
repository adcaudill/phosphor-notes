/**
 * Graph building utilities for wiki-style wikilink extraction
 * Decoupled from worker thread for testability
 */

export type WikiGraph = Record<string, string[]>;

/**
 * Extract wikilinks from markdown content
 * Converts [[filename]], [[filename.md]], or [[path/to/file]] format
 * Always returns filenames with .md extension
 * For nested paths like [[People/John]], also creates implicit links to parent paths
 *
 * @param content - Markdown content to parse
 * @returns Array of linked filenames with .md extension (including implicit parent links)
 */
export function extractWikilinks(content: string): string[] {
  const wikiLinkRegex = /\[\[(.*?)\]\]/g;
  const links: string[] = [];

  let match;
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    let link = match[1].trim();
    if (!link) continue; // Skip empty matches

    // Normalize: ensure .md extension
    if (!link.endsWith('.md')) {
      link += '.md';
    }

    // Add the explicit link (preserve duplicates as per original behavior)
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
 * Extract tags from YAML frontmatter
 * Supports multiple formats:
 * 1. tags: [tag1, tag2, tag3]
 * 2. tags: tag1, tag2, tag3
 * 3. #tag1 #tag2 in frontmatter
 *
 * @param content - Markdown content with YAML frontmatter
 * @returns Array of unique tags (lowercase)
 */
export function extractTags(content: string): string[] {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return [];

  const frontmatter = frontmatterMatch[1];
  const tags = new Set<string>();

  // Format 1: tags: [tag1, tag2, tag3]
  const arrayMatch = frontmatter.match(/tags:\s*\[(.*?)\]/);
  if (arrayMatch) {
    const tagList = arrayMatch[1].split(',').map((t) => t.trim().toLowerCase());
    tagList.forEach((t) => tags.add(t));
  }

  // Format 2: tags: tag1, tag2, tag3 (comma-separated)
  if (!arrayMatch) {
    const csvMatch = frontmatter.match(/tags:\s*([^\n]+)/);
    if (csvMatch) {
      const tagList = csvMatch[1].split(',').map((t) => t.trim().toLowerCase());
      tagList.forEach((t) => tags.add(t));
    }
  }

  // Format 3: #tag1 #tag2 (hashtag format)
  const hashtagMatches = frontmatter.matchAll(/#(\w+)/g);
  for (const match of hashtagMatches) {
    tags.add(match[1].toLowerCase());
  }

  return Array.from(tags).sort();
}

/**
 * Build a graph of wikilinks from markdown files
 * Maps each filename to its outgoing links
 * Includes explicit links from [[...]] syntax and implicit links from nested paths
 *
 * @param fileContents - Map of filename to file content
 * @returns Graph object with filename keys and link arrays
 */
export function buildWikiGraph(fileContents: Record<string, string>): WikiGraph {
  const graph: WikiGraph = {};

  for (const [filename, content] of Object.entries(fileContents)) {
    const links = extractWikilinks(content);

    // Also add implicit links from the file's own nested path
    // e.g., if file is "People/John.md", it implicitly links to "People.md"
    const ownPathLinks = getImplicitPathLinks(filename);
    const allLinks = [...links, ...ownPathLinks];

    graph[filename] = allLinks;
  }

  return graph;
}

/**
 * Get implicit parent links for a nested filepath
 * e.g., "People/John.md" returns ["People.md"]
 * For deeply nested paths, returns parents from shallowest to deepest
 * e.g., "Projects/Work/Client/Document.md" returns ["Projects.md", "Projects/Work.md", "Projects/Work/Client.md"]
 *
 * @param filename - The nested filename path
 * @returns Array of implicit parent paths (shallowest to deepest)
 */
function getImplicitPathLinks(filename: string): string[] {
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

/**
 * Validate graph structure and resolve broken links
 * Returns map of each file to existing target files it links to
 *
 * @param graph - Raw wikilink graph
 * @param existingFiles - Set of files that exist in vault
 * @returns Validated graph with only existing targets
 */
export function validateGraph(graph: WikiGraph, existingFiles: Set<string>): WikiGraph {
  const validatedGraph: WikiGraph = {};

  for (const [filename, links] of Object.entries(graph)) {
    // Only include links to files that exist
    const validLinks = links.filter((link) => existingFiles.has(link));
    validatedGraph[filename] = validLinks;
  }

  return validatedGraph;
}

/**
 * Get all incoming links to a file (backlinks)
 * Inverse of the forward graph
 *
 * @param graph - Wikilink graph
 * @param targetFile - Filename to find backlinks for
 * @returns Array of filenames that link to targetFile
 */
export function getBacklinks(graph: WikiGraph, targetFile: string): string[] {
  const backlinks: string[] = [];

  for (const [filename, links] of Object.entries(graph)) {
    if (links.includes(targetFile)) {
      backlinks.push(filename);
    }
  }

  return backlinks.sort();
}

/**
 * Get connected component of graph containing targetFile
 * Useful for finding all related documents
 *
 * @param graph - Wikilink graph
 * @param targetFile - Starting file
 * @returns Set of all files connected to targetFile (directly or indirectly)
 */
export function getConnectedComponent(graph: WikiGraph, targetFile: string): Set<string> {
  const visited = new Set<string>();
  const queue = [targetFile];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Add forward links
    const forwardLinks = graph[current] || [];
    forwardLinks.forEach((link) => {
      if (!visited.has(link)) queue.push(link);
    });

    // Add backward links
    const backLinks = getBacklinks(graph, current);
    backLinks.forEach((link) => {
      if (!visited.has(link)) queue.push(link);
    });
  }

  return visited;
}

/**
 * Find isolated files (files with no links and no backlinks)
 *
 * @param graph - Wikilink graph
 * @returns Array of isolated filenames
 */
export function findIsolatedFiles(graph: WikiGraph): string[] {
  const isolated: string[] = [];

  for (const filename of Object.keys(graph)) {
    const hasOutgoingLinks = (graph[filename] || []).length > 0;
    const hasBacklinks = getBacklinks(graph, filename).length > 0;

    if (!hasOutgoingLinks && !hasBacklinks) {
      isolated.push(filename);
    }
  }

  return isolated.sort();
}

/**
 * Detect circular references in graph
 * Returns cycles found in the graph
 *
 * @param graph - Wikilink graph
 * @returns Array of cycles (each cycle is an array of filenames)
 */
export function detectCycles(graph: WikiGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const neighbors = graph[node] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path]);
      } else if (recursionStack.has(neighbor)) {
        // Found a cycle
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
          const cycle = path.slice(cycleStart);
          // Only add if we haven't already recorded this cycle
          if (!cycles.some((c) => JSON.stringify(c) === JSON.stringify(cycle))) {
            cycles.push(cycle);
          }
        }
      }
    }

    recursionStack.delete(node);
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

/**
 * Get summary statistics about the graph
 *
 * @param graph - Wikilink graph
 * @returns Object with graph statistics
 */
export function getGraphStats(graph: WikiGraph): {
  totalFiles: number;
  totalLinks: number;
  avgLinksPerFile: number;
  isolatedFiles: number;
  cycles: number;
  mostLinked: { file: string; backlinks: number }[];
} {
  const files = Object.keys(graph).length;
  const totalLinks = Object.values(graph).reduce((sum, links) => sum + links.length, 0);
  const isolated = findIsolatedFiles(graph).length;
  const cycles = detectCycles(graph).length;

  // Calculate average links per file
  const avgLinksPerFile = files > 0 ? totalLinks / files : 0;

  // Find most linked files
  const incomingLinkCounts: Record<string, number> = {};
  for (const filename of Object.keys(graph)) {
    const backlinksCount = getBacklinks(graph, filename).length;
    if (backlinksCount > 0) {
      incomingLinkCounts[filename] = backlinksCount;
    }
  }

  const mostLinked = Object.entries(incomingLinkCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([file, count]) => ({ file, backlinks: count }));

  return {
    totalFiles: files,
    totalLinks,
    avgLinksPerFile: Number(avgLinksPerFile.toFixed(2)),
    isolatedFiles: isolated,
    cycles,
    mostLinked
  };
}

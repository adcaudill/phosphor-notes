import { parentPort } from 'worker_threads';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Importer for Logseq graphs
 * Three-pass migration:
 * 1. Scan: Build a map of old filenames to new paths
 * 2. Transform: Read, inject frontmatter, transform syntax, write files
 * 3. Assets: Copy and normalize asset paths
 */

interface FileMap {
  sourcePath: string;
  targetPath: string;
  originalName: string; // "Project.UX" or "2026_01_17"
  cleanTitle: string; // For frontmatter title
  isJournal: boolean;
}

interface ImportProgress {
  type: 'progress';
  current: number;
  total: number;
  currentFile: string;
}

interface ImportError {
  type: 'error';
  message: string;
  file?: string;
}

interface ImportSuccess {
  type: 'success';
  filesImported: number;
  assetsImported: number;
}

/**
 * Convert Logseq date format (YYYY_MM_DD) to ISO format (YYYY-MM-DD)
 */
function convertJournalDate(filename: string): string {
  // Remove .md extension and convert underscores to hyphens
  return filename.replace('.md', '').replace(/_/g, '-');
}

/**
 * Convert ISO date (YYYY-MM-DD) to long form (e.g., "September 1, 2021")
 */
function convertISODateToLongForm(isoDate: string): string {
  // Parse the date string directly to avoid timezone issues
  const [year, month, day] = isoDate.split('-');
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  return formatter.format(date);
}

/**
 * Decode and transform namespaced filenames
 * "Project.App.Design" -> "Project/App/Design" (dots are namespace separators)
 * "People%2Flena.trussell@agilebits.com" -> "People/lena.trussell@agilebits.com" (%2F is path separator, dots are part of name)
 * "C%2B%2B" -> "C++"
 */
function transformNamespacedPath(filename: string): string {
  // Remove .md extension first
  const nameWithoutExt = filename.replace('.md', '');

  // Check if the original filename contains %2F (encoded slash)
  // If it does, the path is already properly separated - just decode it
  if (nameWithoutExt.includes('%2F')) {
    // Decode URI components - %2F becomes /, %2B becomes +, etc.
    return decodeURIComponent(nameWithoutExt);
  }

  // If no %2F present, use dot notation as namespace separators
  // Decode first to handle special characters like C%2B%2B
  const decoded = decodeURIComponent(nameWithoutExt);
  // Split by dots and rejoin with slashes for namespace notation
  return decoded.split('.').join('/');
}

/**
 * Extract title from path - use the last component or full path as specified
 */
function extractTitle(transformedName: string): string {
  // For consistency, use the full hierarchical name with slashes as visual separators
  // Or use just the leaf node - let's use full path for context
  return transformedName;
}

/**
 * Rewrite alias-based wikilinks to canonical titles
 * Example: [[People/rachel.yarnold@agilebits.com]] -> [[People/Rachel Yarnold]]
 */
function rewriteAliasLinks(content: string, aliasMappings: Record<string, string>): string {
  let result = content;

  // For each alias mapping, find wikilinks that use the alias and replace with canonical title
  for (const [aliasPath, canonicalTitle] of Object.entries(aliasMappings)) {
    // Match [[aliasPath]] and replace with [[canonicalTitle]]
    // Be careful to preserve the wikilink syntax
    const aliasRegex = new RegExp(`\\[\\[${escapeRegExp(aliasPath)}\\]\\]`, 'g');
    result = result.replace(aliasRegex, `[[${canonicalTitle}]]`);
  }

  return result;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse Logseq date format strings and return ISO date or null if not a date
 * Handles formats like: "Oct 11th, 2021", "October 11, 2021", "2021-10-11", etc.
 */
function parseLogseqDate(dateStr: string): string | null {
  // Trim whitespace
  dateStr = dateStr.trim();

  // If already in ISO format, return as-is
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return dateStr;
  }

  // Month names for parsing
  const months: Record<string, number> = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12
  };

  // Try to match: "Month Day, Year" or "Month Day, Year" with ordinals
  // e.g., "Oct 11th, 2021" or "October 11, 2021"
  const dateRegex = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i;
  const match = dateStr.match(dateRegex);

  if (match) {
    const monthStr = match[1].toLowerCase();
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);

    const month = months[monthStr];
    if (month && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      const monthStr2 = String(month).padStart(2, '0');
      const dayStr = String(day).padStart(2, '0');
      return `${year}-${monthStr2}-${dayStr}`;
    }
  }

  return null;
}

/**
 * Rewrite date-based wikilinks from Logseq format to ISO format
 * Example: [[Oct 11th, 2021]] -> [[2021-10-11]]
 */
function rewriteDateLinks(content: string): string {
  let result = content;

  // Match all wikilinks and check if they're dates
  const wikiLinkRegex = /\[\[([^[\]]+)\]\]/g;
  const dateReplacements: Record<string, string> = {};

  let match;
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    const linkText = match[1];
    const isoDate = parseLogseqDate(linkText);

    if (isoDate && isoDate !== linkText) {
      // Store replacement for later
      dateReplacements[linkText] = isoDate;
    }
  }

  // Apply all replacements
  for (const [oldDate, newDate] of Object.entries(dateReplacements)) {
    const dateRegex = new RegExp(`\\[\\[${escapeRegExp(oldDate)}\\]\\]`, 'g');
    result = result.replace(dateRegex, `[[${newDate}]]`);
  }

  return result;
}

/**
 * Transform Logseq content to Phosphor-compatible markdown
 * - Extract and convert page properties (e.g., title::, alias::)
 * - Inject YAML frontmatter
 * - Convert task keywords to GFM checkboxes
 * - Normalize links from dot notation to slash notation
 * - Handle encoded characters
 */
function transformContent(
  raw: string,
  isJournal: boolean,
  cleanTitle: string,
  aliasMappings?: Record<string, string>
): string {
  let content = raw;
  let extractedTitle = cleanTitle;

  // 0. Remove YAML frontmatter blocks (--- markers and content between them)
  // This handles Logseq files that have YAML frontmatter
  content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/m, '');

  // 1. Extract and remove Logseq page properties (lines starting with key::)
  // These should be at the top of the file
  const propertyRegex = /^([a-zA-Z-]+):: (.+)$/gm;
  let match;
  const properties: Record<string, string> = {};

  while ((match = propertyRegex.exec(content)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === 'title') {
      extractedTitle = value;
    }
    properties[key] = value;

    // Collect alias mappings for later cleanup pass
    if (key === 'alias' && aliasMappings) {
      // Normalize the alias path (replace dots with slashes, decode URI)
      const normalizedAlias = decodeURIComponent(value).replace(/\./g, '/');
      aliasMappings[normalizedAlias] = extractedTitle;
    }
  }

  // Remove all property lines from content
  content = content.replace(/^[a-zA-Z-]+:: .+$/gm, '').trim();

  // 0. Remove inline Logseq metadata properties (collapsed::, etc.)
  // These properties appear indented within the content and are UI hints for Logseq
  // Pattern: indentation followed by "key:: value"
  content = content.replace(/^\s+[a-zA-Z-]+::\s*.+$/gm, '').trim();

  // 1. Remove LOGBOOK sections (Logseq task state history)
  // These are metadata-only and not needed in Phosphor
  // Pattern: :LOGBOOK:\n... content ...\n:END:
  content = content.replace(/:LOGBOOK:\n([\s\S]*?):END:/g, '');

  // 2. Extract SCHEDULED date with recurrence pattern and store inline
  // Handle multiline case where SCHEDULED is on an indented line below the task
  // Pattern: "- TODO Task\n  SCHEDULED: <2026-08-02 Sun .+1y>"
  const multilineScheduledRegex =
    /^(-\s+(?:TODO|DOING|DONE|LATER|NOW|CANCELED)\s+[^\n]+)\n\s+SCHEDULED:\s*<(\d{4}-\d{2}-\d{2})(?:\s+\w+)?(?:\s+(\.\+[1-9]\d*[ymwdhMS]))?>(.*)$/gm;
  content = content.replace(multilineScheduledRegex, (_match, taskLine, date, recurrence, rest) => {
    // Combine task line with metadata on same line
    let result = taskLine + ` @due(${date})`;
    if (recurrence) {
      // Convert Logseq recurrence format to Phosphor format
      // .+1y -> 1y, .+1m -> 1m, etc.
      const recurPattern = recurrence.match(/[1-9]\d*[ymwdhMS]/);
      if (recurPattern) {
        result += ` @repeat(${recurPattern[0]})`;
      }
    }
    result += rest;
    return result;
  });

  // Also handle single-line SCHEDULED (in case it appears inline)
  const scheduledRegex =
    /SCHEDULED:\s*<(\d{4}-\d{2}-\d{2})(?:\s+\w+)?(?:\s+(\.\+[1-9]\d*[ymwdhMS]))?>/g;
  content = content.replace(scheduledRegex, (_match, date, recurrence) => {
    // Store as task metadata comment for the task parser
    // Format: @due(YYYY-MM-DD) @repeat(interval)
    let result = ` @due(${date})`;
    if (recurrence) {
      // Convert Logseq recurrence format to Phosphor format
      // .+1y -> 1y, .+1m -> 1m, etc.
      const recurPattern = recurrence.match(/[1-9]\d*[ymwdhMS]/);
      if (recurPattern) {
        result += ` @repeat(${recurPattern[0]})`;
      }
    }
    return result;
  });

  // 3. Extract DEADLINE date and store inline (same format as SCHEDULED)
  // Handle multiline case where DEADLINE is on an indented line below the task
  const multilineDeadlineRegex =
    /^(-\s+(?:TODO|DOING|DONE|LATER|NOW|CANCELED)\s+[^\n]+)\n\s+DEADLINE:\s*<(\d{4}-\d{2}-\d{2})(?:\s+\w+)?>(.*)$/gm;
  content = content.replace(multilineDeadlineRegex, (_match, taskLine, date, rest) => {
    // Combine task line with metadata on same line
    let result = taskLine + ` @due(${date})`;
    result += rest;
    return result;
  });

  // Also handle single-line DEADLINE
  const deadlineRegex = /DEADLINE:\s*<(\d{4}-\d{2}-\d{2})(?:\s+\w+)?>/g;
  content = content.replace(deadlineRegex, (_match, date) => {
    // Store as task metadata comment for the task parser
    // Format: @due(YYYY-MM-DD)
    return ` @due(${date})`;
  });

  // 4. Remove orphaned SCHEDULED/DEADLINE lines without proper date format
  content = content.replace(/(?:SCHEDULED|DEADLINE):\s*<[^>]*>\n?/g, '');

  // 5. Transform Tasks
  // TODO/LATER -> [ ]
  content = content.replace(/-\s+(TODO|LATER)\s+/g, '- [ ] ');
  // DOING/NOW -> [/]
  content = content.replace(/-\s+(DOING|NOW)\s+/g, '- [/] ');
  // DONE -> [x]
  content = content.replace(/-\s+DONE\s+/g, '- [x] ');
  // CANCELED -> [x]
  content = content.replace(/-\s+CANCELED\s+/g, '- [x] ');

  // 6. Transform Tags to Wikilinks
  // Logseq: #TagName -> Phosphor: [[TagName]]
  // Match hashtags that are preceded by whitespace or start of line
  content = content.replace(/(^|[\s])(#[a-zA-Z0-9_-]+)/gm, '$1[[$2]]');
  // Remove the hashtag from inside the wikilink
  content = content.replace(/\[\[#([a-zA-Z0-9_-]+)\]\]/g, '[[$1]]');

  // 7. Transform Links
  // Replace [[Namespace.Page]] with [[Namespace/Page]]
  // and handle encoded characters
  content = content.replace(/\[\[(.*?)\]\]/g, (_match, linkText) => {
    // Decode URI components and replace dots with slashes
    const newLink = decodeURIComponent(linkText).replace(/\./g, '/');
    return `[[${newLink}]]`;
  });

  // 8. Transform Assets
  // Logseq: ![](../assets/filename.ext) -> Phosphor: ![[filename.ext]]
  // Convert markdown image syntax to wikilink syntax for Phosphor compatibility
  content = content.replace(/!\[([^\]]*)\]\(\.\.\/assets\/([^)]+)\)/g, '![[$2]]');

  // 9. Remove block embeds (block UUIDs)
  // These won't work in Phosphor, so convert to plain text reference
  content = content.replace(/\(\(([a-f0-9-]+)\)\)/g, '($1)');

  // 10. Build frontmatter
  let titleForFrontmatter = extractedTitle;
  const frontmatterLines: string[] = ['---'];

  if (isJournal) {
    // For journal files, convert the ISO date to long form (e.g., "September 1, 2021")
    titleForFrontmatter = convertISODateToLongForm(cleanTitle);
    frontmatterLines.push(`title: "${titleForFrontmatter}"`);
    frontmatterLines.push(`type: outliner`);
    frontmatterLines.push(`date: ${cleanTitle}`);
  } else {
    frontmatterLines.push(`title: "${titleForFrontmatter}"`);
    frontmatterLines.push(`type: outliner`);
  }

  // Add any other extracted properties
  if (properties['alias']) {
    frontmatterLines.push(`aliases: [${properties['alias']}]`);
  }

  frontmatterLines.push('---');
  frontmatterLines.push('');

  const frontmatter = frontmatterLines.join('\n');

  return frontmatter + content;
}

/**
 * Main import function
 */
async function importLogseqGraph(sourceDir: string, targetDir: string): Promise<void> {
  const fileMappings: FileMap[] = [];
  const aliasMappings: Record<string, string> = {}; // Maps alias paths to canonical titles
  let filesProcessed = 0;
  let assetsProcessed = 0;

  try {
    console.log('[Importer] PASS 1: Starting file scan...');
    // ==========================================
    // PASS 1: SCAN & PLAN
    // ==========================================

    // 1a. Process Journals
    const journalDir = path.join(sourceDir, 'journals');
    if (fs.existsSync(journalDir)) {
      const files = await fsp.readdir(journalDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const newName = convertJournalDate(file);
        fileMappings.push({
          sourcePath: path.join(journalDir, file),
          targetPath: path.join(targetDir, newName + '.md'),
          originalName: file.replace('.md', ''),
          cleanTitle: newName,
          isJournal: true
        });
      }
    }

    // 1b. Process Pages
    const pagesDir = path.join(sourceDir, 'pages');
    if (fs.existsSync(pagesDir)) {
      const files = await fsp.readdir(pagesDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const nameWithoutExt = file.replace('.md', '');
        const transformedPath = transformNamespacedPath(nameWithoutExt);
        const cleanTitle = extractTitle(transformedPath);

        fileMappings.push({
          sourcePath: path.join(pagesDir, file),
          targetPath: path.join(targetDir, transformedPath + '.md'),
          originalName: nameWithoutExt,
          cleanTitle: cleanTitle,
          isJournal: false
        });
      }
    }

    console.log(`[Importer] PASS 1: Scan complete. Found ${fileMappings.length} files.`);

    // ==========================================
    // PASS 2: EXECUTE MIGRATION
    // ==========================================

    console.log('[Importer] PASS 2: Starting content transformation...');
    const totalFiles = fileMappings.length;

    for (const map of fileMappings) {
      filesProcessed++;

      parentPort?.postMessage({
        type: 'progress',
        current: filesProcessed,
        total: totalFiles,
        currentFile: path.basename(map.targetPath)
      } as ImportProgress);

      try {
        // Read content
        const content = await fsp.readFile(map.sourcePath, 'utf-8');

        // Transform content (and collect alias mappings)
        const finalContent = transformContent(
          content,
          map.isJournal,
          map.cleanTitle,
          aliasMappings
        );

        // Ensure directory exists
        const targetDir_ = path.dirname(map.targetPath);
        await fsp.mkdir(targetDir_, { recursive: true });

        // Check for collisions (file already exists)
        try {
          await fsp.access(map.targetPath);
          // File exists - rename the existing one with a .bak extension
          await fsp.rename(map.targetPath, map.targetPath + '.bak');
        } catch {
          // File doesn't exist, no collision
        }

        // Write file
        await fsp.writeFile(map.targetPath, finalContent, 'utf-8');
      } catch (err) {
        const errorMsg = `Failed to process ${map.originalName}: ${String(err)}`;
        console.error('[Importer Error]', errorMsg);
        if (err instanceof Error) {
          console.error('[Stack]', err.stack);
        }
        parentPort?.postMessage({
          type: 'error',
          message: errorMsg,
          file: map.originalName
        } as ImportError);
      }
    }

    console.log('[Importer] PASS 2: Transformation complete.');

    // ==========================================
    // PASS 3: CLEANUP - REWRITE ALIAS LINKS
    // ==========================================

    console.log('[Importer] PASS 3: Starting alias link rewriting...');
    if (Object.keys(aliasMappings).length > 0) {
      for (const map of fileMappings) {
        try {
          // Read the transformed file
          const fileContent = await fsp.readFile(map.targetPath, 'utf-8');

          // Rewrite all alias-based wikilinks to canonical titles
          const cleanedContent = rewriteAliasLinks(fileContent, aliasMappings);

          // Only write if content changed
          if (cleanedContent !== fileContent) {
            await fsp.writeFile(map.targetPath, cleanedContent, 'utf-8');
          }
        } catch (err) {
          const errorMsg = `Failed to rewrite aliases in ${map.originalName}: ${String(err)}`;
          console.error('[Importer Error]', errorMsg);
          if (err instanceof Error) {
            console.error('[Stack]', err.stack);
          }
          parentPort?.postMessage({
            type: 'error',
            message: errorMsg,
            file: map.originalName
          } as ImportError);
        }
      }
    }

    console.log('[Importer] PASS 3: Alias rewriting complete.');

    // ==========================================
    // PASS 4: CLEANUP - REWRITE DATE LINKS
    // ==========================================

    console.log('[Importer] PASS 4: Starting date link rewriting...');
    // Rewrite all date-based wikilinks from Logseq format to ISO format
    for (const map of fileMappings) {
      try {
        // Read the transformed file
        const fileContent = await fsp.readFile(map.targetPath, 'utf-8');

        // Rewrite all date-based wikilinks to ISO format
        const cleanedContent = rewriteDateLinks(fileContent);

        // Only write if content changed
        if (cleanedContent !== fileContent) {
          await fsp.writeFile(map.targetPath, cleanedContent, 'utf-8');
        }
      } catch (err) {
        const errorMsg = `Failed to rewrite date links in ${map.originalName}: ${String(err)}`;
        console.error('[Importer Error]', errorMsg);
        if (err instanceof Error) {
          console.error('[Stack]', err.stack);
        }
        parentPort?.postMessage({
          type: 'error',
          message: errorMsg,
          file: map.originalName
        } as ImportError);
      }
    }

    console.log('[Importer] PASS 4: Date link rewriting complete.');

    // ==========================================
    // PASS 5: ASSETS
    // ==========================================

    console.log('[Importer] PASS 5: Starting asset copy...');
    const assetSource = path.join(sourceDir, 'assets');
    const assetTarget = path.join(targetDir, '_assets');

    if (fs.existsSync(assetSource)) {
      try {
        // Ensure target directory exists
        await fsp.mkdir(assetTarget, { recursive: true });

        // Copy all assets
        const assetFiles = await fsp.readdir(assetSource);
        for (const file of assetFiles) {
          const src = path.join(assetSource, file);
          const dest = path.join(assetTarget, file);
          const stat = await fsp.stat(src);

          if (stat.isDirectory()) {
            // Recursively copy directories
            await copyDirRecursive(src, dest);
          } else {
            // Copy file
            await fsp.copyFile(src, dest);
          }
          assetsProcessed++;
        }
      } catch (err) {
        const errorMsg = `Failed to copy assets: ${String(err)}`;
        console.error('[Importer Error]', errorMsg);
        if (err instanceof Error) {
          console.error('[Stack]', err.stack);
        }
        parentPort?.postMessage({
          type: 'error',
          message: errorMsg
        } as ImportError);
      }
    }

    console.log('[Importer] PASS 5: Asset copy complete.');
    console.log(
      `[Importer] All passes complete. Imported ${filesProcessed} files, ${assetsProcessed} assets.`
    );

    // Success!
    parentPort?.postMessage({
      type: 'success',
      filesImported: filesProcessed,
      assetsImported: assetsProcessed
    } as ImportSuccess);
  } catch (err) {
    const errorMsg = `Fatal error during import: ${String(err)}`;
    console.error('[Importer Error]', errorMsg);
    if (err instanceof Error) {
      console.error('[Stack]', err.stack);
    }
    parentPort?.postMessage({
      type: 'error',
      message: errorMsg
    } as ImportError);
  }
}

/**
 * Recursively copy a directory
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });

  const files = await fsp.readdir(src);
  for (const file of files) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);
    const stat = await fsp.stat(srcFile);

    if (stat.isDirectory()) {
      await copyDirRecursive(srcFile, destFile);
    } else {
      await fsp.copyFile(srcFile, destFile);
    }
  }
}

// Listen for messages from main process
parentPort?.on('message', async (message: { sourceDir: string; targetDir: string }) => {
  try {
    console.log('[Importer] Starting import from', message.sourceDir, 'to', message.targetDir);
    await importLogseqGraph(message.sourceDir, message.targetDir);
    // After successful import, the importLogseqGraph function sends a success message
    // Exit cleanly after a short delay to ensure message is sent
    setTimeout(() => {
      process.exit(0);
    }, 100);
  } catch (err) {
    const errorMsg = `Unexpected error: ${String(err)}`;
    console.error('[Importer Error]', errorMsg);
    if (err instanceof Error) {
      console.error('[Stack]', err.stack);
    }
    parentPort?.postMessage({
      type: 'error',
      message: errorMsg
    } as ImportError);
    // Exit with error code after error message is sent
    setTimeout(() => {
      process.exit(1);
    }, 100);
  }
});

parentPort?.on('error', (err) => {
  console.error('[Importer Worker Error]', err);
});

parentPort?.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[Importer Worker] Exited with code ${code}`);
  }
});

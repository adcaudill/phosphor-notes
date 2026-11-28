/**
 * Rewrites [[wikilinks]] when notes are renamed or moved - pure logic, no
 * filesystem dependency. Used by the shared rename/move code for both the
 * app's own Rename/Move and MCP's move_note.
 *
 * A link targets a note the same way `extractWikilinks` (shared/wikilinks.ts)
 * reads it: everything before the first `|` (alias) and `#` (heading),
 * trimmed, with a leading `./` and a trailing `.md` ignored, compared
 * case-sensitively - exactly how the link graph resolves links. Only the
 * path portion is replaced; the alias, heading, `./`, `.md`, and surrounding
 * spacing are kept as the user wrote them. Embeds (`![[Note]]`) of a renamed
 * note are updated too.
 */

export interface LinkRename {
  /** Old vault-relative path, with or without `.md`. */
  from: string;
  /** New vault-relative path, with or without `.md`. */
  to: string;
  /**
   * Also rewrite links to anything *under* `from` (`from/...`) - for moving a
   * note together with its child notes (People.md + People/John.md).
   */
  prefix?: boolean;
}

const LINK_RE = /\[\[([^\]\n]*?)\]\]/g;

function stripMd(p: string): string {
  return p.replace(/\.md$/i, '');
}

/** Resolves a link's target path against the renames, or null if none applies. */
function renamedTarget(target: string, renames: LinkRename[]): string | null {
  for (const r of renames) {
    const from = stripMd(r.from);
    const to = stripMd(r.to);
    if (target === from) return to;
    if (r.prefix && target.startsWith(from + '/')) return to + target.slice(from.length);
  }
  return null;
}

/** Rewrites every link in `doc` that points at a renamed note. */
export function rewriteLinks(
  doc: string,
  renames: LinkRename[]
): { doc: string; linksChanged: number } {
  let linksChanged = 0;
  const next = doc.replace(LINK_RE, (whole, inner: string) => {
    // Split off the alias first, then the heading, mirroring extractWikilinks.
    const pipe = inner.indexOf('|');
    const beforeAlias = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? '' : inner.slice(pipe);
    const hash = beforeAlias.indexOf('#');
    const pathPart = hash === -1 ? beforeAlias : beforeAlias.slice(0, hash);
    const heading = hash === -1 ? '' : beforeAlias.slice(hash);

    const leading = pathPart.match(/^\s*/)![0];
    const trailing = pathPart.match(/\s*$/)![0];
    let core = pathPart.trim();
    if (core === '') return whole;

    let dotSlash = '';
    if (core.startsWith('./')) {
      dotSlash = './';
      core = core.slice(2);
    }
    const mdMatch = core.match(/\.md$/i);
    const mdSuffix = mdMatch ? mdMatch[0] : '';
    const target = mdSuffix ? core.slice(0, -mdSuffix.length) : core;

    const renamed = renamedTarget(target, renames);
    if (renamed === null) return whole;

    linksChanged++;
    return `[[${leading}${dotSlash}${renamed}${mdSuffix}${trailing}${heading}${alias}]]`;
  });
  return { doc: next, linksChanged };
}

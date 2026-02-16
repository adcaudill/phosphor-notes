---
title: Graph Engine
layout: page
---

**Graph Engine**

This note explains how the application builds and reasons about the internal graph of notes (the "wiki graph"). It covers the link-extraction logic, virtual nodes (temporal hierarchy), indexing behavior in the worker thread, interactions with the main indexer, and the utility algorithms used for validation, backlinks, components and statistics.

**Key Files**

- **Implementation**: [src/main/graphBuilder.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/graphBuilder.ts)
- **Main indexer / file I/O**: [src/main/indexer.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/indexer.ts)
- **Worker indexer**: [src/main/worker/indexer.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/worker/indexer.ts)
- **File watcher**: [src/main/watcher.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/watcher.ts)
- **Wikilink parsing helpers**: [src/shared/wikilinks.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/shared/wikilinks.ts)

**Data model**

- **`WikiGraph`**: The canonical in-memory representation is a map from filename to an array of outgoing link targets (type Record<string, string[]>). Each key is a filename (usually ending in `.md`, but virtual nodes also use `.md`-like IDs such as `2026.md` or `2026-01.md`). See `buildWikiGraph` in `graphBuilder.ts`.

**How links are extracted**

- Source of truth: the link extraction logic lives in [src/shared/wikilinks.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/shared/wikilinks.ts). The worker and main indexer both call the same helpers so behavior is consistent between threaded and main-thread indexing.
- Extraction steps (simplified):
  - Find all `[[...]]` occurrences ignoring transclusions prefixed with `!`.
  - Strip aliases and headings (i.e. `file|alias` and `file#heading` become `file`).
  - Normalize `./` relative markers by removing them.
  - If a link has a file extension, treat known media extensions as attachments and skip them (they are not added to the graph). If the extension is absent or ambiguous (e.g. `example.com`) the code appends `.md` so the graph uses page-like targets.
  - For nested paths (e.g. `People/John.md`) the extractor emits explicit parent targets as additional links (e.g. `People.md`). This guarantees that hierarchical navigation is represented in the graph.

See `extractWikilinks` for exact behavior, including the media extension blacklist.

**Implicit path links**

- `getImplicitPathLinks(filename)` (in `src/shared/wikilinks.ts`) returns an array of parent-level implicit links for any nested path. For example `Projects/ProjA/notes.md` produces `Projects.md` and `Projects/ProjA.md`. This function is used both when parsing explicit wikilinks and when building the outgoing-links for a file itself (so a file at a nested path implicitly links to its parents).

**Virtual temporal nodes (daily notes -> months -> years)**

- The system recognizes daily notes by filename format YYYY-MM-DD.md via `isDailyNote` and `extractDateHierarchy` in `src/main/graphBuilder.ts` (and duplicated logic in the worker).
- `generateVirtualTemporalNodes(files: string[])` produces a small subgraph containing year nodes (e.g. `2026.md`) which point to month nodes (e.g. `2026-01.md`) which in turn point at the daily notes (e.g. `2026-01-13.md`). These are virtual nodes — they are created only in the graph and do not require backing files on disk. The virtual graph is merged into the main graph during indexing.

**Worker indexing flow**

- The worker entrypoint is [src/main/worker/indexer.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/worker/indexer.ts). The worker receives an array of `{ filename, content }` objects via `parentPort` and processes them in parallel.
- For each file the worker:
  - Calls `extractWikilinks(content)` to get explicit wikilinks.
  - Calls `getImplicitPathLinks(filename)` to add implicit parent links for the file's own path.
  - Deduplicates links (preserves first-seen insertion order) by creating a Set and writing the result to `graph[filename]`.
  - Extracts tasks using a regex-based `extractTasks` helper and emits a flat task array.
  - Indexes the file into MiniSearch (if available) with fields `title`, `content`, and `tags`.
- After all files are processed the worker calls `generateVirtualTemporalNodes(...)` and merges those nodes into the graph. Finally the worker posts a `graph-complete` message with `{ graph, tasks }` back to the main thread.

Notes:

- MiniSearch is dynamically imported in the worker to support multiple module contexts; search initialization occurs in `initSearch()` and documents are added via `searchEngine.add(...)`.
- The worker intentionally ignores read errors for robustness and logs counts on completion.

**Main-thread indexing and I/O**

- The main indexer lives in [src/main/indexer.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/indexer.ts). It is responsible for reading files from disk, handling vault encryption (via `isEncryptionEnabled`, `getActiveMasterKey`, and `decryptBuffer`), and delegating heavy work to the worker thread via `new Worker(...)`.
- File reading is done via `readMarkdownFile(filePath, vaultPath)`. If the vault is encrypted and a master key is available the file buffer is decrypted; on decryption failure the code falls back to treating the buffer as plaintext.
- `getFilesRecursively(dir)` is used to collect `.md` files in the vault for full indexing.
- The indexer also manages a separate prediction model for text completion — it computes token / n-gram / casing statistics per file and merges them globally. That behavior is separate from graph construction but coexists in the same module.

**Graph construction API (graphBuilder.ts)**

- `buildWikiGraph(fileContents: Record<string,string>, files?: string[])` is a reusable helper that builds a graph from an in-memory map of filename→content. It:
  - Calls `extractWikilinks(content)` for each file.
  - Calls `getImplicitPathLinks(filename)` for the file's own path.
  - Adds virtual temporal nodes when a `files` list is provided by calling `generateVirtualTemporalNodes(files)`.
  - Returns the raw `WikiGraph` (a mapping of filename → outgoing-link list).
- `validateGraph(graph, existingFiles)` filters outgoing links to only those targets that exist (based on a provided set). This is used to remove broken links from views that expect only reachable targets.

**Graph utility algorithms**

- `getBacklinks(graph, targetFile)` — linear scan over graph keys to find files that include `targetFile` in their outgoing list. Returns a sorted array.
- `getConnectedComponent(graph, targetFile)` — BFS-like traversal that follows forward edges and also looks up backwards links (via `getBacklinks`) to find the entire connected component containing `targetFile`.
- `findIsolatedFiles(graph)` — returns files with no outgoing links and no backlinks.
- `detectCycles(graph)` — DFS that tracks a recursion stack to find back-edges, collects cycles (deduplicated by stringifying arrays). Implemented in `graphBuilder.ts`.
- `getGraphStats(graph)` — computes total files, total links, average links per file, isolated-count, cycle-count and top-most-linked files by computing backlink counts.

Complexity notes:

- Most utilities scan the graph (O(N + E)) where N is node count and E is edge count. `getBacklinks` is O(N + E) per invocation; the code uses it in places like `getConnectedComponent` which makes the component traversal effectively O(N + E \* f) where f depends on how many times backlinks are recomputed. For typical vault sizes this is acceptable; if scaling becomes a problem a precomputed reverse index could be added.

**Task extraction**

- The worker's `extractTasks` uses a regex to find checklist items (`- [ ]`, `- [/]`, `- [x]`) and maps these to `todo|doing|done`. It attempts to parse due dates and completion timestamps from several syntaxes (`@due(YYYY-MM-DD)`, `📅 YYYY-MM-DD`, `DEADLINE: <YYYY-MM-DD>`, and `✓ YYYY-MM-DD HH:MM:SS`). Extracted tasks are included in the `graph-complete` payload.

**Watcher integration**

- [src/main/watcher.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/watcher.ts) uses `chokidar` to observe the vault. It debounces rapid FS events and ignores internal saves (via `markInternalSave()` and a small grace window) to avoid re-indexing changes the app itself wrote.
- On changes the watcher sends `vault:file-changed`, `vault:file-added`, and `vault:file-deleted` IPC messages to the renderer and calls registered callbacks (the main indexer registers callbacks to perform targeted reindexing for the affected file).

**Normalization and edge cases**

- Attachments and media links are ignored for graph edges (the attachment extension blacklist is in `extractWikilinks`).
- Transclusions prefixed with `![[...]]` are skipped — they are treated as embedded content rather than navigational links.
- Links that look like domain names (contain a dot) are treated as page names and `.md` is appended unless the extension is a known media extension.
- Virtual nodes are only added where the file list is provided; `buildWikiGraph` merges them without overwriting existing keys (so a real file named `2026.md` will take precedence over a virtual year node).

**Search indexing**

- The worker dynamically loads MiniSearch and builds an in-memory index using the fields `title`, `content`, and `tags`. Search requests are handled by the worker and return results with short content snippets.

**Example: what a small graph looks like**

Suppose the vault contains:

- `2026-01-13.md` with content linking to `[[ProjectX]]` and `[[People/John.md]]`
- `ProjectX.md` with no outgoing links

The worker will produce a `graph` roughly like:

- `2026-01-13.md` → [`ProjectX.md`, `People/John.md`, `People.md`]
- `ProjectX.md` → []
- `People/John.md` → [`People.md`]
- `2026-01.md` → [`2026-01-13.md`, ...] (virtual month node)
- `2026.md` → [`2026-01.md`, ...] (virtual year node)

After `validateGraph(graph, existingFiles)` where `existingFiles` is the set of real filenames on disk, the validated graph will contain only links present in `existingFiles` (virtual nodes remain because they are created with the file list input).

**Where to change behavior**

- To adjust how wikilinks are parsed (e.g. change attachment handling or alias rules): edit [src/shared/wikilinks.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/shared/wikilinks.ts).
- To change virtual node format (for example different naming for year/month): edit `generateVirtualTemporalNodes` in [src/main/graphBuilder.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/graphBuilder.ts) (and the corresponding worker copy at [src/main/worker/indexer.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/worker/indexer.ts)).
- To alter task extraction rules: edit `extractTasks` in [src/main/worker/indexer.ts](https://github.com/adcaudill/phosphor-notes/blob/main/src/main/worker/indexer.ts).

**Implementation notes & rationale**

- Parsing and indexing are split: the worker handles CPU-bound parsing and indexing (MiniSearch), while the main process handles I/O, decryption and coalescing updates into the worker. This keeps the main UI thread responsive.
- The system intentionally emits implicit parent links for nested paths so hierarchical navigation works without requiring duplicate explicit links in content.
- Virtual temporal nodes are a convenience layer; because they are generated from the file list they can be re-generated when the set of files changes and don't require on-disk artifacts.

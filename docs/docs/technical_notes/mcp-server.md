---
title: 'Local MCP Server'
layout: page
---

**Overview**

- **What:** Phosphor Notes can run a local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server, letting AI apps you run yourself - Claude Desktop, Claude Code, and other MCP-capable clients - read your vault, and optionally create, add to, and edit notes. Off by default; reading, writing, and editing existing text each require an explicit opt-in.
- **Where:** Enable it in **Preferences \> AI Access**. It runs inside the same process as the app itself; there is no separate helper binary.

**Privacy: read this before enabling**

Once enabled, any AI app you authorize can read your vault's contents, and that content will be sent to whatever LLM backend that app uses. This is a real change from "your data never leaves your machine." The app shows this disclosure once when you turn the feature on. A second, separate toggle and disclosure govern write access - see below. If you don't use MCP-capable AI tools, there's no reason to enable either.

**How it works**

- A local HTTP server (the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) MCP transport) binds to `127.0.0.1` only - it is never reachable from another machine on your network, and never from a browser page's JavaScript (no CORS headers are ever sent, and any request carrying an `Origin` header is rejected outright).
- Requests must present a bearer token, generated locally in the app. Only its SHA-256 hash is ever written to disk (`.phosphor/mcp.json` under Electron's `userData` directory) - the plaintext token is shown once, right after you generate it, and is not recoverable afterward. Regenerating a token immediately invalidates the old one.
- The server only runs while the app is open, and it only answers tool calls (other than `get_vault_status`) while a vault is open **and** unlocked. **There is no tool to unlock the vault remotely** - the password never becomes reachable from an MCP client. If the vault is locked, tools return a clear error asking you to unlock it in the app.

**Read tools**

| Tool | What it does |
|---|---|
| `get_vault_status` | Vault name, open/locked/readable state, and what AI apps may change - the only tool that works before unlocking |
| `list_notes` | List notes, optionally scoped to a folder |
| `read_note` | Full text and parsed frontmatter of one note, plus a `hash` used for the version check described below |
| `search_notes` | Full-text search. Requires every query word to match (unlike the app's own Cmd+K search, which is deliberately forgiving) - a compound query like an email address won't return unrelated notes that only share one word with it. |
| `list_tasks` | Filter checkbox tasks by status, file, or due date |
| `get_note_links` | A note's outgoing wikilinks and backlinks |
| `get_graph_stats` | Vault-wide link graph statistics |
| `list_tags` / `find_notes_by_tag` | Frontmatter tags across the vault |

All reads come from what's saved on disk. Unsaved edits sitting in the editor are not reflected.

**Write tools (separate opt-in)**

A second toggle, off by default even when read access is on, controls write access - it shows its own disclosure and requires the server itself to already be enabled. When it's off, the write tools below aren't just refused - they don't appear in the tool list at all.

| Tool | What it does |
|---|---|
| `create_note` | Creates a new note. Refuses to overwrite an existing one unless you're explicitly asked to allow it, in which case the old content is saved as a version first (see "Undo and history" below). |
| `append_to_note` | Adds content to the *end* of an existing note. |
| `insert_under_bullet` | Adds content under a *specific existing bullet* elsewhere in an outliner note (found by matching its text), rather than only at the very end - useful for filing new content under an already-existing heading-like bullet instead of creating a duplicate. |
| `add_task` | Adds one checkbox task, by default to today's daily journal (auto-created if needed). |
| `complete_task` | Checks off a task; for a recurring task, also adds the next occurrence below it. |
| `update_task` / `reschedule_task` | Changes a task's text, status, due date, recurrence, or priority. |
| `delete_task` | Removes one task line. |
| `list_note_versions` / `read_note_version` | Lists and reads the saved versions described under "Undo and history". |

Without edit access (below), these are the only ways to change an existing note: there is no tool that edits other existing text in place, and no tool at all that deletes, renames, or moves a note.

Notes created or appended to this way automatically match the target note's own formatting convention - see "Outliner vs. freeform" below. Writes take effect immediately; there's no per-call confirmation dialog from Phosphor itself; the connected AI app's own tool-approval UI is the safety net for that, and every change can be reverted afterwards.

**Edit access (a third opt-in)**

A further toggle, nested under write access and off by default, lets AI apps change or remove text that's already in a note rather than only add to it. It has its own disclosure, and turning write access (or the server) off also turns it off, so it never comes back without a fresh confirmation. Tools that need it aren't listed unless it's on:

| Tool | What it does |
|---|---|
| `restore_note_version` | Puts a saved version of a note back (see "Undo and history"). |

Even with edit access, AI apps cannot delete, rename, or move whole notes.

**Limiting writes to certain folders**

With write access on, Settings also lets you list folders AI apps may change ("Only allow changes in these folders" - empty means the whole vault) and folders they may never change ("Never allow changes in these folders", which always wins). A folder includes its subfolders and its own index note (`People.md` for `People`), and matching ignores case. Writes outside the allowed folders are refused with `PATH_NOT_IN_WRITE_SCOPE`, and parent index notes Phosphor would normally create for a nested path are skipped if they fall outside. Daily notes live at the top of the vault, so limiting writes to folders also stops AI apps adding tasks to today's note. `get_vault_status` reports the current access level and folder limits, so a connected app knows what it may do.

**Undo and history**

Before any write changes an existing note, Phosphor saves the note exactly as it was (still encrypted, in an encrypted vault) to the vault's `.phosphor/history/` folder. Versions are kept for 30 days, up to 500 in total, and write tools return the saved version's id as `versionId`.

- **In the app:** Preferences > AI Access > **Recent AI changes** lists each note an AI app changed, with a **Revert** button.
- **From the AI app:** `list_note_versions` and `read_note_version` show the saved versions; `restore_note_version` (edit access only) puts one back.

A revert saves the content it replaces first, so a revert can itself be undone the same way. Restoring decrypts and re-encrypts for the vault's current state, so a version saved before you turned on encryption is never restored as plaintext.

**Safety checks on every write**

- **Unsaved edits:** a write to a note you have open with unsaved changes is refused (`NOTE_HAS_UNSAVED_EDITS`) instead of racing your autosave; the AI app can retry once it's saved.
- **Version check:** `read_note` returns a `hash` for the note. Write tools accept it back as `expectedHash` and refuse (`NOTE_CHANGED`) if the note changed since it was read. The hash is keyed with a secret that never leaves the app, so it can't be used to guess redacted values.
- **Redacted values:** reads mask anything that looks like a US Social Security number or a payment card number. A write containing one of those masks is refused (`REDACTED_CONTENT`), so text copied from a read can never replace the real value with the placeholder.
- **Crash safety:** writes go to a temporary file that's then renamed over the note, so a crash or power loss mid-write can't leave a half-written note.

**Outliner vs. freeform**

A note's format is entirely determined by its own frontmatter (`mode: outliner` vs. anything else/absent). `create_note` picks a sensible default (your journal-mode setting for daily-note-named files, freeform otherwise) unless you specify one; `append_to_note`, `insert_under_bullet`, and `add_task` always detect the target's existing mode and format new content to match - plain paragraphs for freeform notes, properly nested `- ` bullets (4 spaces per level) for outliner notes. Relative indentation is preserved, not flattened: an indented line in what's written becomes a nested child, an unindented one a new top-level (or, for `insert_under_bullet`, top-of-that-subtree) bullet. Checkbox tasks (`- [ ] ...`) work the same way in both modes. `insert_under_bullet` only applies to outliner notes - it matches an existing bullet by a case-insensitive substring of its own text and requires that match to be unique, erroring with a list of candidates if it isn't.

**Known limitations**

- An AI client that connected before write or edit access was turned on may need to reconnect (or you may need to restart it) to see the new tools appear.

**Connecting a client**

After enabling the server and generating a token, the Settings panel shows ready-to-use snippets:

- **Claude Code:**
  ```
  claude mcp add --transport http phosphor http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
  ```
- **Claude Desktop and other stdio-only clients**, via the community [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge:
  ```json
  {
    "command": "npx",
    "args": ["-y", "mcp-remote", "http://127.0.0.1:<port>/mcp", "--header", "Authorization:${PHOSPHOR_AUTH}"],
    "env": { "PHOSPHOR_AUTH": "Bearer <token>" }
  }
  ```
- **Generic HTTP client:** POST to `http://127.0.0.1:<port>/mcp` with an `Authorization: Bearer <token>` header.

**A note on prompt injection**

Note content is untrusted input once it flows into an AI client through these tools. A note containing text crafted to look like instructions (for example, pasted from an untrusted source) could attempt to steer a connected AI assistant into misusing its *other* tools. Keeping this integration read-only (or limiting writes to specific folders) limits what a compromised note can cause Phosphor itself to do, and every write can be reverted from Recent AI changes, but it's still worth keeping an eye on what a connected AI client does with the content it reads.

**Implementation notes**

- Server: `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`, run statelessly (a fresh server instance per request) inside `src/main/mcp/`.
- The read path (`src/main/vaultReader.ts`) is shared with the rest of the app and enforces the same encryption and path-safety rules as everything else - it rejects paths outside the vault, symlink escapes, and non-`.md` files, and never returns ciphertext as if it were plaintext.
- Lifecycle, port binding, and the on-disk config are owned by `src/main/mcp/controller.ts`.

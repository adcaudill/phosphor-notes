---
title: 'Local MCP Server'
layout: page
---

**Overview**

- **What:** Phosphor Notes can run a local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server, letting AI apps you run yourself - Claude Desktop, Claude Code, and other MCP-capable clients - read your vault, and optionally create/append to notes. Off by default; both reading and writing require an explicit opt-in.
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
| `get_vault_status` | Vault name, open/locked/readable state - the only tool that works before unlocking |
| `list_notes` | List notes, optionally scoped to a folder |
| `read_note` | Full text and parsed frontmatter of one note |
| `search_notes` | Full-text search |
| `list_tasks` | Filter checkbox tasks by status, file, or due date |
| `get_note_links` | A note's outgoing wikilinks and backlinks |
| `get_graph_stats` | Vault-wide link graph statistics |
| `list_tags` / `find_notes_by_tag` | Frontmatter tags across the vault |

All reads come from what's saved on disk. Unsaved edits sitting in the editor are not reflected.

**Write tools (separate opt-in)**

A second toggle, off by default even when read access is on, controls write access - it shows its own disclosure and requires the server itself to already be enabled. When it's off, the write tools below aren't just refused - they don't appear in the tool list at all.

| Tool | What it does |
|---|---|
| `create_note` | Creates a new note. Refuses to overwrite an existing one unless you're explicitly asked to allow it, in which case the old content is backed up to a `.bak` file first. |
| `append_to_note` | Adds content to the *end* of an existing note - the only way to modify an existing note through this connection. There is no tool that edits the middle of a note or replaces its content wholesale. |
| `add_task` | Adds one checkbox task, by default to today's daily journal (auto-created if needed). |

Notes created or appended to this way automatically match the target note's own formatting convention - see "Outliner vs. freeform" below. Writes take effect immediately; there's no per-call confirmation dialog from Phosphor itself; the connected AI app's own tool-approval UI is the safety net for that.

**Outliner vs. freeform**

A note's format is entirely determined by its own frontmatter (`mode: outliner` vs. anything else/absent). `create_note` picks a sensible default (your journal-mode setting for daily-note-named files, freeform otherwise) unless you specify one; `append_to_note` and `add_task` always detect the target's existing mode and format new content to match - plain paragraphs for freeform notes, properly nested `- ` bullets (4 spaces per level) for outliner notes. Checkbox tasks (`- [ ] ...`) work the same way in both modes.

**Known limitations**

- If you have unsaved edits open in the very same note an AI app just wrote to, there's a narrow window where your own autosave could still overwrite that write before Phosphor's usual conflict prompt appears - this is a pre-existing edge case in the save pipeline, not something MCP writes work around.
- An AI client that connected before write access was turned on may need to reconnect (or you may need to restart it) to see the write tools appear.

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

Note content is untrusted input once it flows into an AI client through these tools. A note containing text crafted to look like instructions (for example, pasted from an untrusted source) could attempt to steer a connected AI assistant into misusing its *other* tools. Keeping this integration read-only limits what a compromised note can cause Phosphor itself to do, but it's still worth keeping an eye on what a connected AI client does with the content it reads.

**Implementation notes**

- Server: `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`, run statelessly (a fresh server instance per request) inside `src/main/mcp/`.
- The read path (`src/main/vaultReader.ts`) is shared with the rest of the app and enforces the same encryption and path-safety rules as everything else - it rejects paths outside the vault, symlink escapes, and non-`.md` files, and never returns ciphertext as if it were plaintext.
- Lifecycle, port binding, and the on-disk config are owned by `src/main/mcp/controller.ts`.

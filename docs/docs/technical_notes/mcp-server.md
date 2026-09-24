---
title: 'Local MCP Server'
layout: page
---

**Overview**

- **What:** Phosphor Notes can run a local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server, letting AI apps you run yourself - Claude Desktop, Claude Code, and other MCP-capable clients - read your vault. It's read-only, off by default, and requires an explicit opt-in.
- **Where:** Enable it in **Preferences \> AI Access**. It runs inside the same process as the app itself; there is no separate helper binary.

**Privacy: read this before enabling**

Once enabled, any AI app you authorize can read your vault's contents, and that content will be sent to whatever LLM backend that app uses. This is a real change from "your data never leaves your machine." The app shows this disclosure once when you turn the feature on. If you don't use MCP-capable AI tools, there's no reason to enable it.

**How it works**

- A local HTTP server (the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) MCP transport) binds to `127.0.0.1` only - it is never reachable from another machine on your network, and never from a browser page's JavaScript (no CORS headers are ever sent, and any request carrying an `Origin` header is rejected outright).
- Requests must present a bearer token, generated locally in the app. Only its SHA-256 hash is ever written to disk (`.phosphor/mcp.json` under Electron's `userData` directory) - the plaintext token is shown once, right after you generate it, and is not recoverable afterward. Regenerating a token immediately invalidates the old one.
- The server only runs while the app is open, and it only answers tool calls (other than `get_vault_status`) while a vault is open **and** unlocked. **There is no tool to unlock the vault remotely** - the password never becomes reachable from an MCP client. If the vault is locked, tools return a clear error asking you to unlock it in the app.
- All tools are read-only in this release. No note, task, or file can be created, edited, or deleted through MCP.

**Tools exposed**

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

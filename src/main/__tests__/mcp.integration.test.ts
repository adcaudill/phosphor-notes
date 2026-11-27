import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequestListener } from '../mcp/httpServer';
import { createPhosphorMcpServer } from '../mcp/server';
import { generateToken, hashToken } from '../mcp/auth';
import * as vaultReader from '../vaultReader';
import * as vaultWriter from '../vaultWriter';
import * as vaultState from '../vaultState';
import { auditLog } from '../mcp/audit';
import { buildWikiGraph } from '../graphBuilder';
import type { NoteMode } from '../../shared/noteFormat';
import type { McpDeps } from '../mcp/deps';
import { createWriteGate } from '../mcp/writeGate';
import * as noteHistory from '../noteHistory';
import { UNRESTRICTED_SCOPE, type WriteScope } from '../mcp/scope';
import type { Task } from '../../types/phosphor.d';

// End-to-end test: a real StreamableHTTPServerTransport on an ephemeral
// loopback port, driven by the SDK's own Client - the closest thing to
// "run it like a real MCP client would" available for a headless backend
// service like this one (there's no GUI surface for this feature yet).
describe('MCP server (integration)', () => {
  let server: http.Server;
  let port: number;
  let token: string;
  let deps: McpDeps;
  let readable: boolean;
  let writeEnabled: boolean;
  let editEnabled: boolean;
  let writeScope: WriteScope;
  const dirtyNotes = new Set<string>();
  let journalMode: NoteMode;
  let vault: string;
  const TODAY = '2026-09-23.md';

  beforeAll(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-mcp-integration-'));
    fs.writeFileSync(
      path.join(vault, 'top.md'),
      '---\ntitle: Top\n---\nHello from the top note. See [[People/John]].'
    );
    fs.mkdirSync(path.join(vault, 'People'));
    fs.writeFileSync(path.join(vault, 'People', 'John.md'), 'About John.');
    fs.writeFileSync(
      path.join(vault, 'tagged.md'),
      '---\ntags: [project, urgent]\n---\n- [ ] Overdue task 📅 2020-01-01\n- [x] Done task\n'
    );

    const fileContents: Record<string, string> = {
      'top.md': fs.readFileSync(path.join(vault, 'top.md'), 'utf-8'),
      'People/John.md': fs.readFileSync(path.join(vault, 'People', 'John.md'), 'utf-8'),
      'tagged.md': fs.readFileSync(path.join(vault, 'tagged.md'), 'utf-8')
    };
    const graph = buildWikiGraph(fileContents, Object.keys(fileContents));

    const tasks: Task[] = [
      {
        file: 'tagged.md',
        line: 3,
        status: 'todo',
        text: 'Overdue task',
        rawText: '- [ ] Overdue task 📅 2020-01-01',
        dueDate: '2020-01-01'
      },
      {
        file: 'tagged.md',
        line: 4,
        status: 'done',
        text: 'Done task',
        rawText: '- [x] Done task'
      }
    ];

    token = generateToken();
    readable = true;
    writeEnabled = true;
    editEnabled = true;
    writeScope = UNRESTRICTED_SCOPE;
    journalMode = 'outliner';
    const gate = createWriteGate({
      getWriteScope: () => writeScope,
      isNoteDirty: async (relPath) => dirtyNotes.has(relPath)
    });
    deps = {
      getVaultPath: () => vault,
      isReadable: async () => readable,
      isEncryptionEnabled: async () => false,
      // Reads vaultWriter's own real generation counter, since encodeForVault
      // checks it directly - a fixed fake value would desync from it and
      // make every write fail with VAULT_STATE_CHANGED.
      getGeneration: () => vaultState.getGeneration(),
      isIndexReady: () => true,
      getAppVersion: () => '0.0.0-test',
      listNotes: (folder?: string) => vaultReader.listNotes(vault, folder),
      readNote: (relPath: string) => vaultReader.readNoteText(vault, relPath),
      isWriteEnabled: () => writeEnabled,
      isEditEnabled: () => writeEnabled && editEnabled,
      getWriteScope: () => writeScope,
      getDefaultJournalMode: async () => journalMode,
      todayDailyNotePath: () => TODAY,
      createNote: async (relPath, body, opts, ctx) => {
        await gate.check(relPath);
        return vaultWriter.createNote(vault, relPath, body, {
          mode: opts.mode,
          overwrite: opts.overwrite,
          expectedHash: opts.expectedHash,
          canCreateParent: gate.canCreateParent,
          expectedGeneration: ctx.generation,
          history: { tool: ctx.tool }
        });
      },
      appendToNote: async (relPath, addition, ctx, createIfMissing, appendOpts) => {
        await gate.check(relPath);
        return vaultWriter.appendToNote(vault, relPath, addition, {
          expectedGeneration: ctx.generation,
          createIfMissing,
          expectedHash: appendOpts?.expectedHash,
          canCreateParent: gate.canCreateParent,
          history: { tool: ctx.tool }
        });
      },
      insertUnderBullet: async (relPath, matchText, addition, ctx, insertOpts) => {
        await gate.check(relPath);
        return vaultWriter.insertUnderBullet(vault, relPath, matchText, addition, {
          expectedGeneration: ctx.generation,
          occurrence: insertOpts?.occurrence,
          expectedHash: insertOpts?.expectedHash,
          history: { tool: ctx.tool }
        });
      },
      replaceLines: async (relPath, target, newLines, ctx) => {
        await gate.check(relPath);
        return vaultWriter.replaceLines(vault, relPath, target, newLines, {
          expectedGeneration: ctx.generation,
          history: { tool: ctx.tool }
        });
      },
      listVersions: (listOpts) => noteHistory.listVersions(vault, listOpts),
      readVersion: async (id) => {
        const { entry, raw } = await noteHistory.readVersion(vault, id);
        return { entry, text: raw.toString('utf-8') };
      },
      restoreVersion: (id, ctx, restoreOpts) =>
        vaultWriter.restoreVersion(vault, id, {
          expectedGeneration: ctx.generation,
          expectedHash: restoreOpts?.expectedHash,
          history: { tool: ctx.tool },
          beforeWrite: (relPath) => gate.check(relPath)
        }),
      searchNotes: async (query: string) => [
        { filename: 'top.md', title: 'Top', snippet: `...${query}...` }
      ],
      getTasks: () => tasks,
      getGraph: () => graph
    };

    const listener = createRequestListener({
      getTokenHash: () => hashToken(token),
      getPort: () => port,
      buildServer: () => createPhosphorMcpServer(deps)
    });
    server = http.createServer(listener);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  beforeEach(() => {
    readable = true;
    writeEnabled = true;
    editEnabled = true;
    writeScope = UNRESTRICTED_SCOPE;
    dirtyNotes.clear();
    journalMode = 'outliner';
  });

  async function makeClient(bearerToken: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } }
    });
    await client.connect(transport);
    return client;
  }

  it('only binds to the loopback address', () => {
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
  });

  it('lists tools and calls get_vault_status end-to-end', async () => {
    const client = await makeClient(token);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('get_vault_status');

    const result = await client.callTool({ name: 'get_vault_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      open: true,
      vaultName: path.basename(vault),
      encrypted: false,
      locked: false,
      readable: true,
      indexReady: true,
      appVersion: '0.0.0-test'
    });

    await client.close();
  });

  it('lists and reads real notes from the vault end-to-end', async () => {
    const client = await makeClient(token);

    const listed = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(listed.isError).toBeFalsy();
    const paths = (listed.structuredContent as { notes: Array<{ path: string }> }).notes.map(
      (n) => n.path
    );
    expect(paths.sort()).toEqual(['People/John.md', 'tagged.md', 'top.md']);

    const read = await client.callTool({
      name: 'read_note',
      arguments: { path: 'People/John.md' }
    });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({
      path: 'People/John.md',
      title: 'John',
      content: 'About John.'
    });

    const frontmatterRead = await client.callTool({
      name: 'read_note',
      arguments: { path: 'top.md' }
    });
    expect(frontmatterRead.structuredContent).toMatchObject({
      frontmatter: { title: 'Top' }
    });

    await client.close();
  });

  it('rejects read_note for a path-traversal attempt', async () => {
    const client = await makeClient(token);
    const result = await client.callTool({
      name: 'read_note',
      arguments: { path: '../outside.md' }
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('PATH_NOT_ALLOWED');
    await client.close();
  });

  it('rejects note tools while the vault is locked', async () => {
    readable = false;
    const client = await makeClient(token);
    const result = await client.callTool({ name: 'list_notes', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('VAULT_LOCKED');
    await client.close();
  });

  it('reports a locked/unreadable vault via get_vault_status rather than erroring', async () => {
    readable = false;
    const client = await makeClient(token);

    const result = await client.callTool({ name: 'get_vault_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ readable: false });

    await client.close();
  });

  it('rejects a request with no bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/i);
  });

  it('rejects a request with the wrong bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer phos_totally-wrong-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(res.status).toBe(401);
  });

  it('rejects a disallowed Host header', async () => {
    // fetch() silently ignores an overridden Host header (it's treated as a
    // forbidden request header), so a raw http.request is used here to
    // actually exercise the server's Host validation.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: 'evil.example.com',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          }
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    });
    expect(status).toBe(403);
  });

  it('rejects any request carrying an Origin header (never reachable from a browser)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin: 'http://127.0.0.1:5173'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for any path other than /mcp', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/anything-else`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status).toBe(404);
  });

  it('rejects a token after regeneration invalidates the old one', async () => {
    // Simulate regenerateToken(): swap the hash the listener checks against.
    let currentToken = token;
    let oneOffPort = 0;
    const listener = createRequestListener({
      getTokenHash: () => hashToken(currentToken),
      getPort: () => oneOffPort,
      buildServer: () => createPhosphorMcpServer(deps)
    });
    const oneOffServer = http.createServer(listener);
    await new Promise<void>((resolve) => {
      oneOffServer.listen(0, '127.0.0.1', resolve);
    });
    oneOffPort = (oneOffServer.address() as AddressInfo).port;
    try {
      const oldToken = currentToken;
      currentToken = generateToken();

      const res = await fetch(`http://127.0.0.1:${oneOffPort}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${oldToken}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => {
        oneOffServer.closeAllConnections();
        oneOffServer.close(() => resolve());
      });
    }
  });

  it('searches notes end-to-end', async () => {
    const client = await makeClient(token);
    const result = await client.callTool({
      name: 'search_notes',
      arguments: { query: 'hello' }
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ path: 'top.md', title: 'Top', snippet: '...hello...' }]
    });
    await client.close();
  });

  it('masks SSNs and card numbers in tool output end-to-end', async () => {
    const client = await makeClient(token);
    const result = await client.callTool({
      name: 'search_notes',
      arguments: { query: '123-45-6789 4111 1111 1111 1111' }
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [{ snippet: '...[REDACTED SSN] [REDACTED CARD]...' }]
    });
    expect(JSON.stringify(result.content)).not.toMatch(/6789|1111/);
    await client.close();
  });

  it('lists tasks with status and overdue filters end-to-end', async () => {
    const client = await makeClient(token);

    const all = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect((all.structuredContent as { total: number }).total).toBe(2);

    const overdue = await client.callTool({
      name: 'list_tasks',
      arguments: { status: 'todo', overdue: true }
    });
    expect(overdue.structuredContent).toMatchObject({
      total: 1,
      tasks: [{ text: 'Overdue task', status: 'todo' }]
    });

    await client.close();
  });

  it('gets a note’s backlinks and vault-wide graph stats end-to-end', async () => {
    const client = await makeClient(token);

    const links = await client.callTool({
      name: 'get_note_links',
      arguments: { path: 'People/John.md' }
    });
    expect(links.structuredContent).toMatchObject({
      path: 'People/John.md',
      backlinks: ['top.md']
    });

    const stats = await client.callTool({ name: 'get_graph_stats', arguments: {} });
    expect(stats.isError).toBeFalsy();
    expect((stats.structuredContent as { totalFiles: number }).totalFiles).toBeGreaterThan(0);

    await client.close();
  });

  it('lists tags and finds notes by tag end-to-end', async () => {
    const client = await makeClient(token);

    const tags = await client.callTool({ name: 'list_tags', arguments: {} });
    expect(tags.structuredContent).toMatchObject({
      tags: expect.arrayContaining([
        { tag: 'project', count: 1 },
        { tag: 'urgent', count: 1 }
      ])
    });

    const found = await client.callTool({
      name: 'find_notes_by_tag',
      arguments: { tag: 'URGENT' }
    });
    expect(found.structuredContent).toMatchObject({
      notes: [{ path: 'tagged.md', title: 'tagged' }]
    });

    await client.close();
  });

  describe('write tools', () => {
    function snapshot(): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(path.relative(vault, full));
        }
      };
      walk(vault);
      return out.sort();
    }

    it('lists write tools only when write access is enabled', async () => {
      writeEnabled = false;
      const clientOff = await makeClient(token);
      const namesOff = (await clientOff.listTools()).tools.map((t) => t.name);
      expect(namesOff).not.toContain('create_note');
      expect(namesOff).not.toContain('append_to_note');
      expect(namesOff).not.toContain('add_task');
      expect(namesOff).not.toContain('insert_under_bullet');
      await clientOff.close();

      writeEnabled = true;
      const clientOn = await makeClient(token);
      const namesOn = (await clientOn.listTools()).tools.map((t) => t.name);
      expect(namesOn).toEqual(
        expect.arrayContaining([
          'create_note',
          'append_to_note',
          'add_task',
          'complete_task',
          'update_task',
          'reschedule_task',
          'delete_task',
          'insert_under_bullet'
        ])
      );
      await clientOn.close();
    });

    it('refuses a write call when write access is off (the tool is not registered at all)', async () => {
      writeEnabled = false;
      const client = await makeClient(token);
      // create_note isn't in this request's tool list at all, so the SDK
      // reports a protocol-level "tool not found" error rather than a
      // normal WRITE_DISABLED tool result - withVaultWriteGuard's own
      // isWriteEnabled() check is defense in depth for a stale client that
      // cached an older tools/list, not reachable in this exact path.
      const result = await client.callTool({
        name: 'create_note',
        arguments: { path: 'ShouldNotExist.md', content: 'x' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain(
        'create_note not found'
      );
      expect(fs.existsSync(path.join(vault, 'ShouldNotExist.md'))).toBe(false);
      await client.close();
    });

    it('creates a new note with generated frontmatter, including parent stubs for a nested path', async () => {
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'create_note',
        arguments: { path: 'WriteTest/New.md', content: 'Hello new note' }
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        created: true,
        overwritten: false,
        mode: 'freeform',
        parentsCreated: ['WriteTest.md']
      });
      expect(fs.readFileSync(path.join(vault, 'WriteTest/New.md'), 'utf-8')).toBe(
        '---\ntitle: WriteTest/New\n---\nHello new note\n'
      );
      expect(fs.existsSync(path.join(vault, 'WriteTest.md'))).toBe(true);
      await client.close();
    });

    it('refuses to overwrite an existing note by default, and saves the old version on overwrite:true', async () => {
      const client = await makeClient(token);
      await client.callTool({
        name: 'create_note',
        arguments: { path: 'Overwrite.md', content: 'original' }
      });

      const refused = await client.callTool({
        name: 'create_note',
        arguments: { path: 'Overwrite.md', content: 'clobber' }
      });
      expect(refused.isError).toBe(true);
      expect((refused.content as Array<{ text: string }>)[0].text).toContain('NOTE_ALREADY_EXISTS');
      expect(fs.readFileSync(path.join(vault, 'Overwrite.md'), 'utf-8')).toContain('original');

      const overwritten = await client.callTool({
        name: 'create_note',
        arguments: { path: 'Overwrite.md', content: 'replacement', overwrite: true }
      });
      expect(overwritten.isError).toBeFalsy();
      const { versionId, backupPath } = overwritten.structuredContent as {
        versionId: string;
        backupPath?: string;
      };
      expect(backupPath).toBeUndefined();
      expect(fs.readFileSync(path.join(vault, 'Overwrite.md'), 'utf-8')).toContain('replacement');

      // The old content is in note history, not a .bak file beside the note.
      const version = await client.callTool({
        name: 'read_note_version',
        arguments: { id: versionId }
      });
      expect((version.structuredContent as { content: string }).content).toContain('original');
      expect(fs.readdirSync(vault).filter((n) => n.startsWith('Overwrite.'))).toEqual([
        'Overwrite.md'
      ]);

      // History must never show up in list_notes.
      const listed = await client.callTool({ name: 'list_notes', arguments: {} });
      const paths = (listed.structuredContent as { notes: Array<{ path: string }> }).notes.map(
        (n) => n.path
      );
      expect(paths.some((p) => p.startsWith('.phosphor'))).toBe(false);

      await client.close();
    });

    it('rejects create_note path traversal, writing nothing outside the vault', async () => {
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'create_note',
        arguments: { path: '../escape.md', content: 'x' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('PATH_NOT_ALLOWED');
      expect(fs.existsSync(path.join(vault, '..', 'escape.md'))).toBe(false);
      await client.close();
    });

    it('fails append_to_note on a missing note with NOTE_NOT_FOUND, creating nothing', async () => {
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'NoSuchNote.md', content: 'text' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('NOTE_NOT_FOUND');
      expect(fs.existsSync(path.join(vault, 'NoSuchNote.md'))).toBe(false);
      await client.close();
    });

    it('appends correctly-bulleted content to an outliner note end-to-end', async () => {
      fs.writeFileSync(
        path.join(vault, 'Outline.md'),
        '---\nmode: outliner\n---\n- existing\n    - child\n'
      );
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Outline.md', content: 'new top-level\nanother' }
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ mode: 'outliner' });
      expect(fs.readFileSync(path.join(vault, 'Outline.md'), 'utf-8')).toBe(
        '---\nmode: outliner\n---\n- existing\n    - child\n- new top-level\n- another\n'
      );
      await client.close();
    });

    it('appends a paragraph to a freeform note end-to-end', async () => {
      fs.writeFileSync(path.join(vault, 'Freeform.md'), 'First paragraph.');
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Freeform.md', content: 'Second paragraph.' }
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ mode: 'freeform' });
      expect(fs.readFileSync(path.join(vault, 'Freeform.md'), 'utf-8')).toBe(
        'First paragraph.\n\nSecond paragraph.\n'
      );
      await client.close();
    });

    it('inserts under an existing bullet, after its existing children, end-to-end', async () => {
      fs.writeFileSync(
        path.join(vault, 'Nested.md'),
        '---\nmode: outliner\n---\n- [[IOmergent]]\n    - Meetings\n        - Standup\n- Personal\n'
      );
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'insert_under_bullet',
        arguments: { path: 'Nested.md', matchText: 'Meetings', content: 'Planning session' }
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        mode: 'outliner',
        matchedText: 'Meetings'
      });
      expect(fs.readFileSync(path.join(vault, 'Nested.md'), 'utf-8')).toBe(
        '---\nmode: outliner\n---\n' +
          '- [[IOmergent]]\n' +
          '    - Meetings\n' +
          '        - Standup\n' +
          '        - Planning session\n' +
          '- Personal\n'
      );
      await client.close();
    });

    it('rejects insert_under_bullet on a freeform note', async () => {
      fs.writeFileSync(path.join(vault, 'PlainNote.md'), 'Just prose.');
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'insert_under_bullet',
        arguments: { path: 'PlainNote.md', matchText: 'prose', content: 'x' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('NOT_OUTLINER_MODE');
      expect(fs.readFileSync(path.join(vault, 'PlainNote.md'), 'utf-8')).toBe('Just prose.');
      await client.close();
    });

    it('reports AMBIGUOUS_MATCH listing every match when matchText is not unique', async () => {
      const doc = '---\nmode: outliner\n---\n- Notes\n- Project Notes\n';
      fs.writeFileSync(path.join(vault, 'Ambiguous.md'), doc);
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'insert_under_bullet',
        arguments: { path: 'Ambiguous.md', matchText: 'Notes', content: 'x' }
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('AMBIGUOUS_MATCH');
      expect(text).toContain('Project Notes');
      expect(fs.readFileSync(path.join(vault, 'Ambiguous.md'), 'utf-8')).toBe(doc);
      await client.close();
    });

    it('reports BULLET_NOT_FOUND without writing when nothing matches', async () => {
      const doc = '---\nmode: outliner\n---\n- Something\n';
      fs.writeFileSync(path.join(vault, 'NoMatch.md'), doc);
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'insert_under_bullet',
        arguments: { path: 'NoMatch.md', matchText: 'Nonexistent', content: 'x' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('BULLET_NOT_FOUND');
      expect(fs.readFileSync(path.join(vault, 'NoMatch.md'), 'utf-8')).toBe(doc);
      await client.close();
    });

    it("add_task with no file creates and appends to today's daily note", async () => {
      const client = await makeClient(token);
      const first = await client.callTool({
        name: 'add_task',
        arguments: { text: 'Buy milk', due: '2026-10-01' }
      });

      expect(first.isError).toBeFalsy();
      expect(first.structuredContent).toMatchObject({ created: true, mode: 'outliner' });
      const afterFirst = fs.readFileSync(path.join(vault, TODAY), 'utf-8');
      expect(afterFirst).toContain('- [ ] Buy milk 📅 2026-10-01');
      expect(afterFirst).toContain('type: daily');
      expect(afterFirst).toContain('mode: outliner');

      const second = await client.callTool({
        name: 'add_task',
        arguments: { text: 'Walk the dog' }
      });
      expect(second.structuredContent).toMatchObject({ created: false });
      const afterSecond = fs.readFileSync(path.join(vault, TODAY), 'utf-8');
      expect(afterSecond).toContain('- [ ] Buy milk 📅 2026-10-01');
      expect(afterSecond).toContain('- [ ] Walk the dog');

      await client.close();
    });

    it('does not auto-create an explicitly-named missing file for add_task', async () => {
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'add_task',
        arguments: { text: 'x', file: 'NeverCreated.md' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('NOTE_NOT_FOUND');
      expect(fs.existsSync(path.join(vault, 'NeverCreated.md'))).toBe(false);
      await client.close();
    });

    it('rejects an impossible due date without writing anything', async () => {
      const before = fs.existsSync(path.join(vault, TODAY))
        ? fs.readFileSync(path.join(vault, TODAY), 'utf-8')
        : null;

      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'add_task',
        arguments: { text: 'x', due: '2026-02-30' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('INVALID_ARGUMENT');

      const after = fs.existsSync(path.join(vault, TODAY))
        ? fs.readFileSync(path.join(vault, TODAY), 'utf-8')
        : null;
      expect(after).toBe(before);
      await client.close();
    });

    it('complete_task marks a task done and inserts the next occurrence for a recurring task', async () => {
      // A far-future due date keeps this deterministic regardless of the
      // real current date: completeTask always advances from "now" (no
      // deterministic override in the MCP tool surface), and a recurring
      // task's catch-up clamp would otherwise skip ahead past a near-past
      // due date to the day after the real today.
      fs.writeFileSync(
        path.join(vault, 'CompleteTest.md'),
        '- [ ] Daily standup 📅 2099-01-15 🔁 +1d\n- [ ] One-off 📅 2026-01-15\n'
      );
      const client = await makeClient(token);

      const recurring = await client.callTool({
        name: 'complete_task',
        arguments: {
          file: 'CompleteTest.md',
          line: 1,
          rawText: '- [ ] Daily standup 📅 2099-01-15 🔁 +1d'
        }
      });
      expect(recurring.isError).toBeFalsy();
      expect(recurring.structuredContent).toMatchObject({ nextLineNumber: 2 });
      const afterRecurring = fs.readFileSync(path.join(vault, 'CompleteTest.md'), 'utf-8');
      expect(afterRecurring).toContain('- [x] Daily standup 📅 2099-01-15 🔁 +1d ✓');
      expect(afterRecurring).toContain('- [ ] Daily standup 📅 2099-01-16 🔁 +1d');

      const oneOff = await client.callTool({
        name: 'complete_task',
        arguments: { file: 'CompleteTest.md', line: 3, rawText: '- [ ] One-off 📅 2026-01-15' }
      });
      expect(oneOff.isError).toBeFalsy();
      const oneOffContent = oneOff.structuredContent as {
        nextLine?: string;
        nextLineNumber?: number;
      };
      expect(oneOffContent.nextLine).toBeUndefined();
      expect(oneOffContent.nextLineNumber).toBeUndefined();
      const afterOneOff = fs.readFileSync(path.join(vault, 'CompleteTest.md'), 'utf-8');
      expect(afterOneOff).toContain('- [x] One-off 📅 2026-01-15 ✓');

      await client.close();
    });

    it('complete_task refuses with LINE_MISMATCH when the line has changed since it was read', async () => {
      fs.writeFileSync(path.join(vault, 'MismatchTest.md'), '- [ ] Real text\n');
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'complete_task',
        arguments: { file: 'MismatchTest.md', line: 1, rawText: '- [ ] Stale text' }
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('LINE_MISMATCH');
      expect(fs.readFileSync(path.join(vault, 'MismatchTest.md'), 'utf-8')).toBe(
        '- [ ] Real text\n'
      );
      await client.close();
    });

    it('update_task edits text, due date, recurrence, priority, and status without embedded syntax', async () => {
      fs.writeFileSync(path.join(vault, 'UpdateTest.md'), '- [ ] Draft the proposal\n');
      const client = await makeClient(token);

      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          file: 'UpdateTest.md',
          line: 1,
          rawText: '- [ ] Draft the proposal',
          newText: 'Send the proposal',
          due: '2026-03-01',
          recurrence: '+1w',
          priority: 'high'
        }
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        taskLine: '- [ ] Send the proposal 🔺 📅 2026-03-01 🔁 +1w'
      });
      expect(fs.readFileSync(path.join(vault, 'UpdateTest.md'), 'utf-8')).toBe(
        '- [ ] Send the proposal 🔺 📅 2026-03-01 🔁 +1w\n'
      );

      const cleared = await client.callTool({
        name: 'update_task',
        arguments: {
          file: 'UpdateTest.md',
          line: 1,
          rawText: '- [ ] Send the proposal 🔺 📅 2026-03-01 🔁 +1w',
          due: '',
          recurrence: '',
          priority: 'none',
          status: 'done'
        }
      });
      expect(cleared.isError).toBeFalsy();
      const finalText = fs.readFileSync(path.join(vault, 'UpdateTest.md'), 'utf-8');
      expect(finalText).toMatch(
        /^- \[x\] Send the proposal ✓ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n$/
      );

      await client.close();
    });

    it('reschedule_task sets and clears the due date only', async () => {
      fs.writeFileSync(
        path.join(vault, 'RescheduleTest.md'),
        '- [/] In progress 🔼 📅 2026-01-01\n'
      );
      const client = await makeClient(token);

      const rescheduled = await client.callTool({
        name: 'reschedule_task',
        arguments: {
          file: 'RescheduleTest.md',
          line: 1,
          rawText: '- [/] In progress 🔼 📅 2026-01-01',
          due: '2026-05-05'
        }
      });
      expect(rescheduled.structuredContent).toMatchObject({
        taskLine: '- [/] In progress 🔼 📅 2026-05-05'
      });

      const cleared = await client.callTool({
        name: 'reschedule_task',
        arguments: {
          file: 'RescheduleTest.md',
          line: 1,
          rawText: '- [/] In progress 🔼 📅 2026-05-05',
          due: ''
        }
      });
      expect(cleared.structuredContent).toMatchObject({ taskLine: '- [/] In progress 🔼' });
      await client.close();
    });

    it('delete_task removes the line and nothing else', async () => {
      fs.writeFileSync(
        path.join(vault, 'DeleteTest.md'),
        '- [ ] keep me\n- [ ] delete me\n- [ ] also keep\n'
      );
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'delete_task',
        arguments: { file: 'DeleteTest.md', line: 2, rawText: '- [ ] delete me' }
      });
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(path.join(vault, 'DeleteTest.md'), 'utf-8')).toBe(
        '- [ ] keep me\n- [ ] also keep\n'
      );
      await client.close();
    });

    it('leaves the vault completely untouched when locked', async () => {
      readable = false;
      const before = snapshot();

      const client = await makeClient(token);
      for (const call of [
        { name: 'create_note', arguments: { path: 'Locked.md', content: 'x' } },
        { name: 'append_to_note', arguments: { path: 'top.md', content: 'x' } },
        { name: 'add_task', arguments: { text: 'x' } }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text: string }>)[0].text).toContain('VAULT_LOCKED');
      }
      await client.close();

      expect(snapshot()).toEqual(before);
    });

    it('records the affected path in the audit log for a successful write', async () => {
      const client = await makeClient(token);
      await client.callTool({
        name: 'create_note',
        arguments: { path: 'Audited.md', content: 'x' }
      });
      await client.close();

      const entry = auditLog
        .recent()
        .reverse()
        .find((e) => e.tool === 'create_note' && e.target === 'Audited.md');
      expect(entry).toMatchObject({ ok: true, write: true, target: 'Audited.md' });
    });

    it('returns a content hash from read_note and refuses a write with a stale expectedHash', async () => {
      fs.writeFileSync(path.join(vault, 'Hashed.md'), 'first\n');
      const client = await makeClient(token);
      const read = await client.callTool({ name: 'read_note', arguments: { path: 'Hashed.md' } });
      const hash = (read.structuredContent as { hash: string }).hash;
      expect(hash).toMatch(/^[0-9a-f]{32}$/);

      // Matching hash: the append goes through and returns the new hash.
      const ok = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Hashed.md', content: 'second', expectedHash: hash }
      });
      expect(ok.isError).toBeFalsy();
      const newHash = (ok.structuredContent as { hash: string }).hash;
      expect(newHash).not.toBe(hash);

      // The original hash is now stale.
      const stale = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Hashed.md', content: 'third', expectedHash: hash }
      });
      expect(stale.isError).toBe(true);
      expect((stale.content as Array<{ text: string }>)[0].text).toContain('NOTE_CHANGED');
      expect(fs.readFileSync(path.join(vault, 'Hashed.md'), 'utf-8')).not.toContain('third');

      const reread = await client.callTool({ name: 'read_note', arguments: { path: 'Hashed.md' } });
      expect((reread.structuredContent as { hash: string }).hash).toBe(newHash);
      await client.close();
    });

    it('refuses any write whose arguments contain a redaction placeholder (REDACTED_CONTENT)', async () => {
      fs.writeFileSync(path.join(vault, 'Secret.md'), 'SSN 123-45-6789\n');
      const client = await makeClient(token);

      // What the client sees when it reads the note:
      const read = await client.callTool({ name: 'read_note', arguments: { path: 'Secret.md' } });
      const shown = (read.structuredContent as { content: string }).content;
      expect(shown).toContain('[REDACTED SSN]');

      // Writing that text back must be refused rather than replacing the real number.
      for (const call of [
        { name: 'append_to_note', arguments: { path: 'Secret.md', content: shown } },
        {
          name: 'create_note',
          arguments: { path: 'Secret.md', content: shown, overwrite: true }
        },
        { name: 'add_task', arguments: { text: `call about ${shown}` } }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text: string }>)[0].text).toContain('REDACTED_CONTENT');
      }
      expect(fs.readFileSync(path.join(vault, 'Secret.md'), 'utf-8')).toBe('SSN 123-45-6789\n');
      await client.close();
    });

    it('reports the access level and folder scope in get_vault_status', async () => {
      editEnabled = false;
      writeScope = { allow: ['Inbox'], deny: ['Inbox/Private'] };
      const client = await makeClient(token);
      const status = await client.callTool({ name: 'get_vault_status', arguments: {} });
      expect((status.structuredContent as { access: unknown }).access).toEqual({
        write: true,
        edit: false,
        writeAllowFolders: ['Inbox'],
        writeDenyFolders: ['Inbox/Private']
      });
      await client.close();
    });

    it('refuses writes outside the folder scope (PATH_NOT_IN_WRITE_SCOPE), including the default daily note', async () => {
      writeScope = { allow: ['Inbox'], deny: ['Inbox/Private'] };
      const before = snapshot();
      const client = await makeClient(token);
      for (const call of [
        { name: 'create_note', arguments: { path: 'Elsewhere.md', content: 'x' } },
        { name: 'create_note', arguments: { path: 'Inbox/Private/x.md', content: 'x' } },
        { name: 'append_to_note', arguments: { path: 'top.md', content: 'x' } },
        // No file: defaults to today's daily note at the vault root - also out of scope.
        { name: 'add_task', arguments: { text: 'x' } }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text: string }>)[0].text).toContain(
          'PATH_NOT_IN_WRITE_SCOPE'
        );
      }
      expect(snapshot()).toEqual(before);
      await client.close();
    });

    it('writes inside the scope, skipping parent stubs that fall outside it', async () => {
      writeScope = { allow: ['Scoped/Area'], deny: [] };
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'create_note',
        arguments: { path: 'Scoped/Area/Deep/Note.md', content: 'hi' }
      });
      expect(result.isError).toBeFalsy();
      // Scoped.md is outside Scoped/Area and is skipped; the in-scope stubs are created.
      expect((result.structuredContent as { parentsCreated: string[] }).parentsCreated).toEqual([
        'Scoped/Area.md',
        'Scoped/Area/Deep.md'
      ]);
      expect(fs.existsSync(path.join(vault, 'Scoped.md'))).toBe(false);
      expect(fs.existsSync(path.join(vault, 'Scoped/Area/Deep/Note.md'))).toBe(true);
      await client.close();
    });

    it('registers history tools by tier: list/read with write access, restore only with edit access', async () => {
      editEnabled = false;
      const writeOnly = await makeClient(token);
      const names = (await writeOnly.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['list_note_versions', 'read_note_version']));
      expect(names).not.toContain('restore_note_version');
      await writeOnly.close();

      editEnabled = true;
      const withEdit = await makeClient(token);
      expect((await withEdit.listTools()).tools.map((t) => t.name)).toContain(
        'restore_note_version'
      );
      await withEdit.close();
    });

    it('undoes a change end to end: write, find the saved version, restore it', async () => {
      fs.writeFileSync(path.join(vault, 'Undo.md'), 'keep this\n');
      const client = await makeClient(token);

      const appended = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Undo.md', content: 'oops' }
      });
      const { versionId } = appended.structuredContent as { versionId: string };
      expect(versionId).toBeTruthy();

      // The audit log ties the write to the version it replaced.
      const audited = auditLog
        .recent()
        .reverse()
        .find((e) => e.tool === 'append_to_note' && e.target === 'Undo.md');
      expect(audited?.versionId).toBe(versionId);

      const listed = await client.callTool({
        name: 'list_note_versions',
        arguments: { path: 'Undo.md' }
      });
      expect(
        (listed.structuredContent as { versions: Array<{ id: string }> }).versions[0]
      ).toMatchObject({
        id: versionId,
        path: 'Undo.md',
        tool: 'append_to_note'
      });

      const restored = await client.callTool({
        name: 'restore_note_version',
        arguments: { id: versionId }
      });
      expect(restored.isError).toBeFalsy();
      expect(fs.readFileSync(path.join(vault, 'Undo.md'), 'utf-8')).toBe('keep this\n');

      const missing = await client.callTool({
        name: 'read_note_version',
        arguments: { id: '1700000000000-00000000' }
      });
      expect((missing.content as Array<{ text: string }>)[0].text).toContain('VERSION_NOT_FOUND');
      await client.close();
    });

    it('applies the folder scope to restores too', async () => {
      fs.writeFileSync(path.join(vault, 'Scoped.md'), 'a\n');
      const client = await makeClient(token);
      const appended = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Scoped.md', content: 'b' }
      });
      const { versionId } = appended.structuredContent as { versionId: string };

      writeScope = { allow: [], deny: ['Scoped'] };
      const refused = await client.callTool({
        name: 'restore_note_version',
        arguments: { id: versionId }
      });
      expect((refused.content as Array<{ text: string }>)[0].text).toContain(
        'PATH_NOT_IN_WRITE_SCOPE'
      );
      expect(fs.readFileSync(path.join(vault, 'Scoped.md'), 'utf-8')).toBe('a\n\nb\n');
      await client.close();
    });

    it('refuses to write a note that is open in the app with unsaved edits (NOTE_HAS_UNSAVED_EDITS)', async () => {
      fs.writeFileSync(path.join(vault, 'Busy.md'), 'mine\n');
      dirtyNotes.add('Busy.md');
      const client = await makeClient(token);
      const refused = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Busy.md', content: 'theirs' }
      });
      expect((refused.content as Array<{ text: string }>)[0].text).toContain(
        'NOTE_HAS_UNSAVED_EDITS'
      );
      expect(fs.readFileSync(path.join(vault, 'Busy.md'), 'utf-8')).toBe('mine\n');

      // Once the user's edit is saved, the same call goes through.
      dirtyNotes.delete('Busy.md');
      const ok = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'Busy.md', content: 'theirs' }
      });
      expect(ok.isError).toBeFalsy();
      await client.close();
    });
  });
});

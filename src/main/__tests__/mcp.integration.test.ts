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
        dueDate: '2020-01-01'
      },
      { file: 'tagged.md', line: 4, status: 'done', text: 'Done task' }
    ];

    token = generateToken();
    readable = true;
    writeEnabled = true;
    journalMode = 'outliner';
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
      getDefaultJournalMode: async () => journalMode,
      todayDailyNotePath: () => TODAY,
      createNote: (relPath, body, opts, ctx) =>
        vaultWriter.createNote(vault, relPath, body, {
          mode: opts.mode,
          overwrite: opts.overwrite,
          expectedGeneration: ctx.generation
        }),
      appendToNote: (relPath, addition, ctx, createIfMissing) =>
        vaultWriter.appendToNote(vault, relPath, addition, {
          expectedGeneration: ctx.generation,
          createIfMissing
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
      await clientOff.close();

      writeEnabled = true;
      const clientOn = await makeClient(token);
      const namesOn = (await clientOn.listTools()).tools.map((t) => t.name);
      expect(namesOn).toEqual(expect.arrayContaining(['create_note', 'append_to_note', 'add_task']));
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
      expect((result.content as Array<{ text: string }>)[0].text).toContain('create_note not found');
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

    it('refuses to overwrite an existing note by default, and backs up on overwrite:true', async () => {
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
      const { backupPath } = overwritten.structuredContent as { backupPath: string };
      expect(backupPath).toMatch(/^Overwrite\.\d+\.md\.bak$/);
      expect(fs.readFileSync(path.join(vault, backupPath), 'utf-8')).toContain('original');
      expect(fs.readFileSync(path.join(vault, 'Overwrite.md'), 'utf-8')).toContain('replacement');

      // The backup must never show up in list_notes.
      const listed = await client.callTool({ name: 'list_notes', arguments: {} });
      const paths = (listed.structuredContent as { notes: Array<{ path: string }> }).notes.map(
        (n) => n.path
      );
      expect(paths).not.toContain(backupPath);

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
  });
});

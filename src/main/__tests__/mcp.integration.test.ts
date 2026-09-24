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
import { buildWikiGraph } from '../graphBuilder';
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
  let vault: string;

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
    deps = {
      getVaultPath: () => vault,
      isReadable: async () => readable,
      isEncryptionEnabled: async () => false,
      getGeneration: () => 1,
      isIndexReady: () => true,
      getAppVersion: () => '0.0.0-test',
      listNotes: (folder?: string) => vaultReader.listNotes(vault, folder),
      readNote: (relPath: string) => vaultReader.readNoteText(vault, relPath),
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
});

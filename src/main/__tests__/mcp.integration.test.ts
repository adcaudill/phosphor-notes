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
import { extractWikilinks } from '../../shared/wikilinks';
import { UNRESTRICTED_SCOPE, type WriteScope } from '../mcp/scope';
import { createTask, deleteTask, updateTask } from '../taskStore';
import {
  clearTaskIndex,
  getTaskDetail,
  getTaskLinks,
  getTaskList,
  loadTaskIndex,
  removeTask,
  searchTaskIds,
  setNoteTaskRefs,
  upsertTask
} from '../taskIndex';
import { syncTaskLinkTitles } from '../taskLinkSync';
import { extractTaskRefs } from '../../shared/taskLinks';

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
  let graph: ReturnType<typeof buildWikiGraph>;
  let writeEnabled: boolean;
  let editEnabled: boolean;
  let organizeEnabled: boolean;
  let deleteEnabled: boolean;
  let tasksEnabled: boolean;
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
    graph = buildWikiGraph(fileContents, Object.keys(fileContents));

    token = generateToken();
    readable = true;
    writeEnabled = true;
    editEnabled = true;
    organizeEnabled = true;
    deleteEnabled = true;
    tasksEnabled = true;
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
      isOrganizeEnabled: () => writeEnabled && editEnabled && organizeEnabled,
      isDeleteEnabled: () => writeEnabled && editEnabled && deleteEnabled,
      isTaskWriteEnabled: () => writeEnabled && tasksEnabled,
      tasks: {
        list: () => getTaskList(),
        search: (text) => searchTaskIds(text),
        get: (id) => getTaskDetail(id),
        create: async (input, ctx) => {
          const task = await createTask(vault, input, {
            expectedGeneration: ctx.generation,
            tool: ctx.tool
          });
          upsertTask(task);
          return task;
        },
        update: async (id, change, ctx, summary) => {
          const task = await updateTask(vault, id, change, {
            expectedGeneration: ctx.generation,
            tool: ctx.tool,
            summary
          });
          upsertTask(task);
          return task;
        },
        delete: async (id, ctx) => {
          await deleteTask(vault, id, { expectedGeneration: ctx.generation, tool: ctx.tool });
          removeTask(id);
        },
        syncLinkTitles: async (id, title, ctx) => {
          const notes = [...new Set(getTaskLinks(id).map((l) => l.note))];
          const skipped = notes.filter((n) => dirtyNotes.has(n));
          const changed = await syncTaskLinkTitles(vault, id, title, {
            expectedGeneration: ctx.generation,
            tool: ctx.tool,
            exclude: skipped
          });
          return { changed, skipped };
        }
      },
      getWriteScope: () => writeScope,
      getDefaultJournalMode: async () => journalMode,
      todayDailyNotePath: () => TODAY,
      createNote: async (relPath, body, opts, ctx) => {
        await gate.check(relPath, { dryRun: opts.dryRun });
        return vaultWriter.createNote(vault, relPath, body, {
          mode: opts.mode,
          overwrite: opts.overwrite,
          expectedHash: opts.expectedHash,
          canCreateParent: gate.canCreateParent,
          expectedGeneration: ctx.generation,
          history: { tool: ctx.tool },
          dryRun: opts.dryRun
        });
      },
      appendToNote: async (relPath, addition, ctx, createIfMissing, appendOpts) => {
        await gate.check(relPath, { dryRun: appendOpts?.dryRun });
        return vaultWriter.appendToNote(vault, relPath, addition, {
          expectedGeneration: ctx.generation,
          createIfMissing,
          expectedHash: appendOpts?.expectedHash,
          canCreateParent: gate.canCreateParent,
          history: { tool: ctx.tool },
          dryRun: appendOpts?.dryRun
        });
      },
      insertUnderBullet: async (relPath, matchText, addition, ctx, insertOpts) => {
        await gate.check(relPath, { dryRun: insertOpts?.dryRun });
        return vaultWriter.insertUnderBullet(vault, relPath, matchText, addition, {
          expectedGeneration: ctx.generation,
          occurrence: insertOpts?.occurrence,
          expectedHash: insertOpts?.expectedHash,
          history: { tool: ctx.tool },
          dryRun: insertOpts?.dryRun
        });
      },
      replaceLines: async (relPath, target, newLines, ctx, replaceOpts) => {
        await gate.check(relPath, { dryRun: replaceOpts?.dryRun });
        return vaultWriter.replaceLines(vault, relPath, target, newLines, {
          expectedGeneration: ctx.generation,
          history: { tool: ctx.tool },
          dryRun: replaceOpts?.dryRun
        });
      },
      moveNote: (from, to, ctx, moveOpts) =>
        vaultWriter.renameNote(vault, from, to, {
          expectedGeneration: ctx.generation,
          includeChildren: moveOpts?.includeChildren,
          expectedHash: moveOpts?.expectedHash,
          dryRun: moveOpts?.dryRun,
          history: { tool: ctx.tool },
          // Stand-in for the link graph: every note in the vault is a candidate.
          linkCandidates: () => allNotes(),
          beforeWrite: (relPath) => gate.check(relPath, { dryRun: moveOpts?.dryRun }),
          canCreateParent: gate.canCreateParent
        }),
      deleteNote: async (relPath, ctx, deleteOpts) => {
        await gate.check(relPath, { dryRun: deleteOpts?.dryRun });
        return vaultWriter.deleteNote(vault, relPath, {
          expectedGeneration: ctx.generation,
          expectedHash: deleteOpts?.expectedHash,
          dryRun: deleteOpts?.dryRun,
          history: { tool: ctx.tool }
        });
      },
      findBacklinks: (relPath) =>
        allNotes().filter(
          (p) =>
            p !== relPath &&
            extractWikilinks(fs.readFileSync(path.join(vault, p), 'utf-8')).includes(relPath)
        ),
      listVersions: (listOpts) => noteHistory.listVersions(vault, listOpts),
      readVersion: async (id) => {
        const { entry, raw } = await noteHistory.readVersion(vault, id);
        return { entry, text: raw.toString('utf-8') };
      },
      modifyNote: async (relPath, transform, ctx, modifyOpts) => {
        await gate.check(relPath, { dryRun: modifyOpts?.dryRun });
        return vaultWriter.modifyNote(vault, relPath, transform, {
          expectedGeneration: ctx.generation,
          expectedHash: modifyOpts?.expectedHash,
          dryRun: modifyOpts?.dryRun,
          history: { tool: ctx.tool, summary: modifyOpts?.summary }
        });
      },
      restoreVersion: (id, ctx, restoreOpts) =>
        vaultWriter.restoreVersion(vault, id, {
          expectedGeneration: ctx.generation,
          expectedHash: restoreOpts?.expectedHash,
          history: { tool: ctx.tool },
          dryRun: restoreOpts?.dryRun,
          beforeWrite: (relPath) => gate.check(relPath, { dryRun: restoreOpts?.dryRun })
        }),
      searchNotes: async (query: string) => [
        { filename: 'top.md', title: 'Top', snippet: `...${query}...` }
      ],
      getGraph: () => graph
    };

    clearTaskIndex();
    await loadTaskIndex(vault);

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
    organizeEnabled = true;
    deleteEnabled = true;
    tasksEnabled = true;
    writeScope = UNRESTRICTED_SCOPE;
    dirtyNotes.clear();
    journalMode = 'outliner';
  });

  /** Every note in the test vault (hidden folders like .phosphor excluded). */
  function allNotes(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md'))
          out.push(path.relative(vault, full).split(path.sep).join('/'));
      }
    };
    walk(vault);
    return out;
  }

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

  it('lists and searches task files with views and filters end-to-end', async () => {
    const ctx = { generation: vaultState.getGeneration(), tool: 'test' };
    const overdue = await deps.tasks.create(
      { title: 'Overdue invoice', due: '2020-01-01', priority: 'high', tags: ['bills'] },
      ctx
    );
    await deps.tasks.create(
      { title: 'Renew passport', notes: 'Photos are in the desk drawer' },
      ctx
    );
    await deps.tasks.create({ title: 'Old plan', status: 'done' }, ctx);
    const client = await makeClient(token);

    const open = await client.callTool({ name: 'list_tasks', arguments: {} });
    expect(
      (open.structuredContent as { tasks: Array<{ title: string }> }).tasks.map((t) => t.title)
    ).toEqual(['Overdue invoice', 'Renew passport']);

    const today = await client.callTool({ name: 'list_tasks', arguments: { view: 'today' } });
    expect(today.structuredContent).toMatchObject({
      total: 1,
      tasks: [{ id: overdue.id, title: 'Overdue invoice', priority: 'high', tags: ['bills'] }]
    });

    const filtered = await client.callTool({
      name: 'list_tasks',
      arguments: { filter: '#bills due:overdue' }
    });
    expect((filtered.structuredContent as { total: number }).total).toBe(1);

    const found = await client.callTool({ name: 'search_tasks', arguments: { query: 'drawer' } });
    expect(found.structuredContent).toMatchObject({
      total: 1,
      tasks: [{ title: 'Renew passport' }]
    });

    const detail = await client.callTool({ name: 'get_task', arguments: { id: overdue.id } });
    expect(detail.structuredContent).toMatchObject({
      task: { id: overdue.id, title: 'Overdue invoice', log: [{ type: 'created' }] },
      links: []
    });

    const missing = await client.callTool({ name: 'get_task', arguments: { id: 'zzzzzzzz' } });
    expect((missing.content as Array<{ text: string }>)[0].text).toContain('TASK_NOT_FOUND');
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
      expect(namesOff).not.toContain('create_task');
      expect(namesOff).toContain('list_tasks'); // reading tasks needs no write access
      expect(namesOff).not.toContain('insert_under_bullet');
      await clientOff.close();

      writeEnabled = true;
      const clientOn = await makeClient(token);
      const namesOn = (await clientOn.listTools()).tools.map((t) => t.name);
      expect(namesOn).toEqual(
        expect.arrayContaining([
          'create_note',
          'append_to_note',
          'create_task',
          'complete_task',
          'skip_occurrence',
          'add_task_comment',
          'update_task',
          'update_checklist',
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
        '---\nmode: outliner\n---\n- [[Acme]]\n    - Meetings\n        - Standup\n- Personal\n'
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
          '- [[Acme]]\n' +
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

    it('create_task reads plain language, and structured fields override it', async () => {
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'create_task',
        arguments: { input: 'pay rent on the first of each month !high #bills', project: 'Home' }
      });
      const task = (result.structuredContent as { task: Record<string, unknown> }).task;
      expect(task).toMatchObject({
        title: 'pay rent',
        priority: 'high',
        tags: ['bills'],
        project: 'Home',
        repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1', from: 'due', label: 'Monthly on the 1st' }
      });
      expect(String(task.due)).toMatch(/^\d{4}-\d{2}-01$/);
      expect(fs.existsSync(path.join(vault, '_tasks', `${task.id}.md`))).toBe(true);

      const structured = await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Water plants',
          repeat: 'every 3 days after done',
          checklist: ['Fern', 'Cactus']
        }
      });
      expect((structured.structuredContent as { task: unknown }).task).toMatchObject({
        title: 'Water plants',
        repeat: { from: 'completion', label: 'Every 3 days after done' },
        checklist: [
          { text: 'Fern', done: false },
          { text: 'Cactus', done: false }
        ]
      });

      const bad = await client.callTool({
        name: 'create_task',
        arguments: { title: 'x', repeat: 'sometimes' }
      });
      expect((bad.content as Array<{ text: string }>)[0].text).toContain('INVALID_ARGUMENT');
      await client.close();
    });

    it('create_task can link the task into a note, under a bullet', async () => {
      fs.writeFileSync(
        path.join(vault, 'Plan.md'),
        '---\nmode: outliner\n---\n- Errands\n- Work\n'
      );
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'create_task',
        arguments: { title: 'Buy stamps', linkInto: { note: 'Plan.md', underBullet: 'Errands' } }
      });
      const { task, linkedInto } = result.structuredContent as {
        task: { id: string };
        linkedInto: string;
      };
      expect(linkedInto).toBe('Plan.md');
      expect(fs.readFileSync(path.join(vault, 'Plan.md'), 'utf-8')).toBe(
        `---\nmode: outliner\n---\n- Errands\n    - [[_task:${task.id}|Buy stamps]]\n- Work\n`
      );
      await client.close();
    });

    it('complete_task moves a repeating task on, and marks a one-off task done', async () => {
      const ctx = { generation: vaultState.getGeneration(), tool: 'test' };
      const weekly = await deps.tasks.create(
        {
          title: 'Standup',
          due: '2020-01-06',
          repeat: { rule: 'FREQ=WEEKLY;BYDAY=MO', from: 'due' }
        },
        ctx
      );
      const once = await deps.tasks.create({ title: 'File taxes' }, ctx);
      const client = await makeClient(token);

      const next = await client.callTool({ name: 'complete_task', arguments: { id: weekly.id } });
      const moved = (next.structuredContent as { task: { status: string; due: string } }).task;
      expect(moved.status).toBe('todo');
      expect(moved.due > '2020-01-06').toBe(true);

      const done = await client.callTool({ name: 'complete_task', arguments: { id: once.id } });
      expect((done.structuredContent as { task: unknown }).task).toMatchObject({ status: 'done' });

      const skipped = await client.callTool({
        name: 'skip_occurrence',
        arguments: { id: once.id }
      });
      expect((skipped.content as Array<{ text: string }>)[0].text).toContain('INVALID_ARGUMENT');
      await client.close();
    });

    it('update_task changes fields and keeps link titles in step (skipping unsaved notes)', async () => {
      const ctx = { generation: vaultState.getGeneration(), tool: 'test' };
      const task = await deps.tasks.create({ title: 'Call Alice', due: '2030-05-01' }, ctx);
      const link = `- [[_task:${task.id}|Call Alice]]\n`;
      fs.writeFileSync(path.join(vault, 'LinkA.md'), link);
      fs.writeFileSync(path.join(vault, 'LinkB.md'), link);
      setNoteTaskRefs('LinkA.md', extractTaskRefs(link));
      setNoteTaskRefs('LinkB.md', extractTaskRefs(link));
      dirtyNotes.add('LinkB.md');
      const client = await makeClient(token);

      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          id: task.id,
          title: 'Call Alice back',
          due: null,
          priority: 'low',
          repeat: 'weekly on fri'
        }
      });
      expect(result.structuredContent).toMatchObject({
        task: { title: 'Call Alice back', priority: 'low', repeat: { label: 'Weekly on Fri' } },
        linksUpdated: ['LinkA.md'],
        linksSkipped: ['LinkB.md']
      });
      expect(fs.readFileSync(path.join(vault, 'LinkA.md'), 'utf-8')).toContain(
        '|Call Alice back]]'
      );
      expect(fs.readFileSync(path.join(vault, 'LinkB.md'), 'utf-8')).toContain('|Call Alice]]');
      dirtyNotes.delete('LinkB.md');

      const list = await client.callTool({
        name: 'update_checklist',
        arguments: { id: task.id, items: [{ text: 'Find number', done: true }, { text: 'Call' }] }
      });
      expect((list.structuredContent as { task: unknown }).task).toMatchObject({
        checklist: [
          { text: 'Find number', done: true },
          { text: 'Call', done: false }
        ]
      });

      const commented = await client.callTool({
        name: 'add_task_comment',
        arguments: { id: task.id, text: 'Left a voicemail' }
      });
      const log = (
        commented.structuredContent as { task: { log: Array<{ type: string; text?: string }> } }
      ).task.log;
      expect(log.at(-1)).toMatchObject({ type: 'comment', text: 'Left a voicemail' });
      await client.close();
    });

    it('delete_task removes the task file, keeping it in history', async () => {
      const ctx = { generation: vaultState.getGeneration(), tool: 'test' };
      const task = await deps.tasks.create({ title: 'Temporary' }, ctx);
      const client = await makeClient(token);
      const result = await client.callTool({ name: 'delete_task', arguments: { id: task.id } });
      expect(result.structuredContent).toMatchObject({ deleted: task.id });
      expect(fs.existsSync(path.join(vault, '_tasks', `${task.id}.md`))).toBe(false);
      const versions = await noteHistory.listVersions(vault, { path: `_tasks/${task.id}.md` });
      expect(versions[0]).toMatchObject({ kind: 'delete' });
      await client.close();
    });

    it('respects the tiers and the tasks switch', async () => {
      const ctx = { generation: vaultState.getGeneration(), tool: 'test' };
      const task = await deps.tasks.create({ title: 'Gated' }, ctx);

      editEnabled = false;
      const noEdit = await makeClient(token);
      const noEditNames = (await noEdit.listTools()).tools.map((t) => t.name);
      expect(noEditNames).toEqual(expect.arrayContaining(['create_task', 'complete_task']));
      expect(noEditNames).not.toContain('update_task');
      expect(noEditNames).not.toContain('delete_task');
      await noEdit.close();
      editEnabled = true;

      tasksEnabled = false;
      const noTasks = await makeClient(token);
      const names = (await noTasks.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('create_task');
      expect(names).toContain('create_note');
      expect(names).toContain('get_task');
      const status = await noTasks.callTool({ name: 'get_vault_status', arguments: {} });
      expect((status.structuredContent as { access: { tasks: boolean } }).access.tasks).toBe(false);
      await noTasks.close();
      expect(deps.tasks.get(task.id)?.task.status).toBe('todo');
    });

    it('leaves the vault completely untouched when locked', async () => {
      readable = false;
      const before = snapshot();

      const client = await makeClient(token);
      for (const call of [
        { name: 'create_note', arguments: { path: 'Locked.md', content: 'x' } },
        { name: 'append_to_note', arguments: { path: 'top.md', content: 'x' } },
        { name: 'create_task', arguments: { title: 'x' } }
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
        { name: 'create_task', arguments: { title: `call about ${shown}` } }
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
        organize: false,
        delete: false,
        tasks: true,
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
        // Tasks themselves aren't in a folder, but linking one into a note is a note write.
        { name: 'create_task', arguments: { title: 'x', linkInto: { note: 'top.md' } } }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect((result.content as Array<{ text: string }>)[0].text).toContain(
          'PATH_NOT_IN_WRITE_SCOPE'
        );
      }
      // Task files are never written as notes, whatever the scope.
      writeScope = UNRESTRICTED_SCOPE;
      for (const call of [
        { name: 'create_note', arguments: { path: '_tasks/k3f9a2xq.md', content: 'x' } },
        { name: 'append_to_note', arguments: { path: '_tasks/k3f9a2xq.md', content: 'x' } }
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

  describe('edit tools', () => {
    function errorText(result: unknown): string {
      return (result as { content: Array<{ text: string }> }).content[0].text;
    }

    /** Every file in the vault (history excluded), so tests can assert nothing on disk changed. */
    function snapshot(): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(`${path.relative(vault, full)}:${fs.readFileSync(full, 'utf-8').length}`);
        }
      };
      walk(vault);
      return out.sort();
    }

    it('lists edit tools only when edit access is on', async () => {
      editEnabled = false;
      const off = await makeClient(token);
      expect((await off.listTools()).tools.map((t) => t.name)).not.toContain('edit_note');
      await off.close();

      editEnabled = true;
      const on = await makeClient(token);
      expect((await on.listTools()).tools.map((t) => t.name)).toContain('edit_note');
      await on.close();
    });

    it('edit_note replaces exact text, returns the change, and can be undone', async () => {
      fs.writeFileSync(path.join(vault, 'Edit.md'), '# Plan\n\nShip in May.\n');
      const client = await makeClient(token);
      const read = await client.callTool({ name: 'read_note', arguments: { path: 'Edit.md' } });
      const { hash } = read.structuredContent as { hash: string };

      const edited = await client.callTool({
        name: 'edit_note',
        arguments: {
          path: 'Edit.md',
          edits: [{ oldText: 'Ship in May.', newText: 'Ship in June.' }],
          expectedHash: hash
        }
      });
      expect(edited.isError).toBeFalsy();
      const out = edited.structuredContent as {
        changed: boolean;
        versionId: string;
        changes: Array<{ line: number; removed: string[]; added: string[] }>;
      };
      expect(out.changed).toBe(true);
      expect(out.changes).toEqual([
        { line: 3, removed: ['Ship in May.'], added: ['Ship in June.'] }
      ]);
      expect(fs.readFileSync(path.join(vault, 'Edit.md'), 'utf-8')).toBe(
        '# Plan\n\nShip in June.\n'
      );

      // The old hash is now stale.
      const stale = await client.callTool({
        name: 'edit_note',
        arguments: {
          path: 'Edit.md',
          edits: [{ oldText: 'June', newText: 'July' }],
          expectedHash: hash
        }
      });
      expect(errorText(stale)).toContain('NOTE_CHANGED');

      await client.callTool({ name: 'restore_note_version', arguments: { id: out.versionId } });
      expect(fs.readFileSync(path.join(vault, 'Edit.md'), 'utf-8')).toBe(
        '# Plan\n\nShip in May.\n'
      );
      await client.close();
    });

    it('edit_note dry run shows the change without writing', async () => {
      fs.writeFileSync(path.join(vault, 'Dry.md'), 'alpha\n');
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'edit_note',
        arguments: { path: 'Dry.md', edits: [{ oldText: 'alpha', newText: 'beta' }], dryRun: true }
      });
      expect(result.structuredContent).toMatchObject({ dryRun: true, changed: true });
      expect(fs.readFileSync(path.join(vault, 'Dry.md'), 'utf-8')).toBe('alpha\n');
      await client.close();
    });

    it('edit_note refuses missing and ambiguous text, writing nothing', async () => {
      fs.writeFileSync(path.join(vault, 'Amb.md'), 'todo one\ntodo two\n');
      const client = await makeClient(token);
      const missing = await client.callTool({
        name: 'edit_note',
        arguments: { path: 'Amb.md', edits: [{ oldText: 'nope', newText: 'x' }] }
      });
      expect(errorText(missing)).toContain('TEXT_NOT_FOUND');
      const ambiguous = await client.callTool({
        name: 'edit_note',
        arguments: { path: 'Amb.md', edits: [{ oldText: 'todo', newText: 'done' }] }
      });
      expect(errorText(ambiguous)).toContain('AMBIGUOUS_MATCH');
      expect(errorText(ambiguous)).toContain('lines 1, 2');
      expect(fs.readFileSync(path.join(vault, 'Amb.md'), 'utf-8')).toBe('todo one\ntodo two\n');
      await client.close();
    });

    it('edit_note honors the write scope and unsaved-edit checks', async () => {
      fs.writeFileSync(path.join(vault, 'Guarded.md'), 'x\n');
      const client = await makeClient(token);

      writeScope = { allow: [], deny: ['Guarded'] };
      const outOfScope = await client.callTool({
        name: 'edit_note',
        arguments: { path: 'Guarded.md', edits: [{ oldText: 'x', newText: 'y' }], dryRun: true }
      });
      expect(errorText(outOfScope)).toContain('PATH_NOT_IN_WRITE_SCOPE');

      writeScope = UNRESTRICTED_SCOPE;
      dirtyNotes.add('Guarded.md');
      const dirty = await client.callTool({
        name: 'edit_note',
        arguments: { path: 'Guarded.md', edits: [{ oldText: 'x', newText: 'y' }] }
      });
      expect(errorText(dirty)).toContain('NOTE_HAS_UNSAVED_EDITS');
      expect(fs.readFileSync(path.join(vault, 'Guarded.md'), 'utf-8')).toBe('x\n');
      await client.close();
    });

    it('update_frontmatter changes keys and tags, leaving the body alone', async () => {
      fs.writeFileSync(
        path.join(vault, 'Front.md'),
        '---\ntitle: Front\ntags: [a]\n---\nBody stays.\n'
      );
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'update_frontmatter',
        arguments: { path: 'Front.md', set: { status: 'done' }, addTags: ['b'], removeTags: ['a'] }
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        changed: true,
        tags: ['b'],
        frontmatter: { title: 'Front', status: 'done', tags: '[b]' }
      });
      expect(fs.readFileSync(path.join(vault, 'Front.md'), 'utf-8')).toBe(
        '---\ntitle: Front\ntags: [b]\nstatus: done\n---\nBody stays.\n'
      );
      await client.close();
    });

    it('update_frontmatter refuses to discard a redacted value, and to change mode', async () => {
      const original = '---\nssn: 123-45-6789\nmode: outliner\n---\n- x\n';
      fs.writeFileSync(path.join(vault, 'FrontSecret.md'), original);
      const client = await makeClient(token);
      const redacted = await client.callTool({
        name: 'update_frontmatter',
        arguments: { path: 'FrontSecret.md', remove: ['ssn'] }
      });
      expect(errorText(redacted)).toContain('REDACTED_CONTENT');
      const mode = await client.callTool({
        name: 'update_frontmatter',
        arguments: { path: 'FrontSecret.md', set: { mode: 'freeform' } }
      });
      expect(errorText(mode)).toContain('INVALID_ARGUMENT');
      expect(fs.readFileSync(path.join(vault, 'FrontSecret.md'), 'utf-8')).toBe(original);
      await client.close();
    });

    const SECTIONED = '---\ntitle: S\n---\n# Doc\n\n## A\n\nAlpha.\n\n## B\n\nBeta.\n';

    it('read_note reads a line range and get_note_outline maps the structure', async () => {
      fs.writeFileSync(path.join(vault, 'Sections.md'), SECTIONED);
      const client = await makeClient(token);
      const ranged = await client.callTool({
        name: 'read_note',
        arguments: { path: 'Sections.md', startLine: 6, endLine: 8 }
      });
      expect(ranged.structuredContent).toMatchObject({
        content: '## A\n\nAlpha.',
        totalLines: 12,
        startLine: 6,
        endLine: 8
      });

      const outline = await client.callTool({
        name: 'get_note_outline',
        arguments: { path: 'Sections.md' }
      });
      expect(outline.structuredContent).toMatchObject({
        mode: 'freeform',
        totalLines: 12,
        items: [
          { line: 4, endLine: 12, level: 1, kind: 'heading', text: 'Doc' },
          { line: 6, endLine: 8, level: 2, kind: 'heading', text: 'A' },
          { line: 10, endLine: 12, level: 2, kind: 'heading', text: 'B' }
        ]
      });
      expect((outline.structuredContent as { hash: string }).hash).toBe(
        (ranged.structuredContent as { hash: string }).hash
      );
      await client.close();
    });

    it('registers insert_at_section with write access, and the other section tools only with edit access', async () => {
      editEnabled = false;
      const writeOnly = await makeClient(token);
      const names = (await writeOnly.listTools()).tools.map((t) => t.name);
      expect(names).toContain('insert_at_section');
      expect(names).toContain('get_note_outline');
      for (const n of ['replace_section', 'delete_section', 'move_section']) {
        expect(names).not.toContain(n);
      }
      await writeOnly.close();
    });

    it('section tools edit by heading text, and line targets require expectedHash', async () => {
      fs.writeFileSync(path.join(vault, 'Sec2.md'), SECTIONED);
      const client = await makeClient(token);

      const noHash = await client.callTool({
        name: 'delete_section',
        arguments: { path: 'Sec2.md', section: { line: 6 } }
      });
      expect(errorText(noHash)).toContain('INVALID_ARGUMENT');

      const replaced = await client.callTool({
        name: 'replace_section',
        arguments: { path: 'Sec2.md', section: { match: 'a' }, content: 'Alpha, revised.' }
      });
      // Case-insensitive: "a" matches only the "A" heading, not "Doc" or "B".
      expect(replaced.isError).toBeFalsy();

      const moved = await client.callTool({
        name: 'move_section',
        arguments: {
          path: 'Sec2.md',
          section: { match: 'B' },
          target: { match: 'A' },
          position: 'before'
        }
      });
      expect(moved.isError).toBeFalsy();
      expect(fs.readFileSync(path.join(vault, 'Sec2.md'), 'utf-8')).toBe(
        '---\ntitle: S\n---\n# Doc\n\n## B\n\nBeta.\n\n## A\n\nAlpha, revised.\n'
      );

      const outline = await client.callTool({
        name: 'get_note_outline',
        arguments: { path: 'Sec2.md' }
      });
      const { hash } = outline.structuredContent as { hash: string };
      const deleted = await client.callTool({
        name: 'delete_section',
        arguments: { path: 'Sec2.md', section: { line: 6 }, expectedHash: hash }
      });
      expect(deleted.structuredContent).toMatchObject({ section: { line: 6, text: 'B' } });
      expect(fs.readFileSync(path.join(vault, 'Sec2.md'), 'utf-8')).toBe(
        '---\ntitle: S\n---\n# Doc\n\n## A\n\nAlpha, revised.\n'
      );
      await client.close();
    });

    it('insert_at_section adds bullets at the right depth in an outliner note', async () => {
      fs.writeFileSync(
        path.join(vault, 'OutIns.md'),
        '---\nmode: outliner\n---\n- Parent\n- Other\n'
      );
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'insert_at_section',
        arguments: {
          path: 'OutIns.md',
          section: { match: 'Parent' },
          position: 'last_child',
          content: 'Child\n  Grandchild'
        }
      });
      expect(result.structuredContent).toMatchObject({ insertedAtLine: 5 });
      expect(fs.readFileSync(path.join(vault, 'OutIns.md'), 'utf-8')).toBe(
        '---\nmode: outliner\n---\n- Parent\n    - Child\n        - Grandchild\n- Other\n'
      );
      await client.close();
    });

    it('refuses to delete or replace a section holding a redacted value', async () => {
      const original = '# Info\n\nSSN 123-45-6789\n\n# Other\n\nx\n';
      fs.writeFileSync(path.join(vault, 'SecSecret.md'), original);
      const client = await makeClient(token);
      for (const call of [
        { name: 'delete_section', arguments: { path: 'SecSecret.md', section: { match: 'Info' } } },
        {
          name: 'replace_section',
          arguments: { path: 'SecSecret.md', section: { match: 'Info' }, content: 'gone' }
        }
      ]) {
        expect(errorText(await client.callTool(call))).toContain('REDACTED_CONTENT');
      }
      expect(fs.readFileSync(path.join(vault, 'SecSecret.md'), 'utf-8')).toBe(original);
      await client.close();
    });

    it('dryRun on the existing write tools reports the result but changes nothing on disk', async () => {
      fs.writeFileSync(path.join(vault, 'DryExisting.md'), '- [ ] Call Sam\n');
      const before = snapshot();
      const versionsBefore = await noteHistory.listVersions(vault, { limit: 1000 });
      const client = await makeClient(token);

      const created = await client.callTool({
        name: 'create_note',
        arguments: { path: 'DryNew/Sub/Note.md', content: 'x', dryRun: true }
      });
      expect(created.structuredContent).toMatchObject({
        dryRun: true,
        created: true,
        parentsCreated: ['DryNew.md', 'DryNew/Sub.md']
      });

      const appended = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'DryExisting.md', content: 'more', dryRun: true }
      });
      expect(appended.structuredContent).toMatchObject({ dryRun: true });

      expect(snapshot()).toEqual(before);
      expect(await noteHistory.listVersions(vault, { limit: 1000 })).toEqual(versionsBefore);
      await client.close();
    });

    it('dryRun still enforces NOTE_ALREADY_EXISTS and the folder scope', async () => {
      fs.writeFileSync(path.join(vault, 'DryExists.md'), 'x\n');
      const client = await makeClient(token);
      const exists = await client.callTool({
        name: 'create_note',
        arguments: { path: 'DryExists.md', content: 'y', dryRun: true }
      });
      expect(errorText(exists)).toContain('NOTE_ALREADY_EXISTS');

      writeScope = { allow: ['Inbox'], deny: [] };
      const scoped = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'DryExists.md', content: 'y', dryRun: true }
      });
      expect(errorText(scoped)).toContain('PATH_NOT_IN_WRITE_SCOPE');
      await client.close();
    });
  });

  describe('organize and delete tools', () => {
    function errorText(result: unknown): string {
      return (result as { content: Array<{ text: string }> }).content[0].text;
    }
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
      fs.writeFileSync(path.join(vault, rel), text);
    };
    const get = (rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf-8');
    const has = (rel: string): boolean => fs.existsSync(path.join(vault, rel));

    it('registers move_note and delete_note only with their own switches; get_daily_note always', async () => {
      organizeEnabled = false;
      deleteEnabled = false;
      const off = await makeClient(token);
      const offNames = (await off.listTools()).tools.map((t) => t.name);
      expect(offNames).toContain('get_daily_note');
      expect(offNames).not.toContain('move_note');
      expect(offNames).not.toContain('delete_note');
      await off.close();

      organizeEnabled = true;
      deleteEnabled = true;
      const on = await makeClient(token);
      const onNames = (await on.listTools()).tools.map((t) => t.name);
      expect(onNames).toEqual(expect.arrayContaining(['move_note', 'delete_note']));
      await on.close();
    });

    it('move_note renames, rewrites links, and restore_note_version moves it back', async () => {
      put('P3/Plan.md', 'The plan.\n');
      put('P3/Hub.md', 'See [[P3/Plan#Goals|goals]] and [[P3/Plan]].\n');
      const client = await makeClient(token);

      const moved = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Plan.md', to: 'P3/Archive/Plan.md' }
      });
      expect(moved.isError).toBeFalsy();
      const out = moved.structuredContent as {
        versionId: string;
        linksUpdated: Array<{ path: string; links: number }>;
        parentsCreated: string[];
      };
      expect(out.linksUpdated).toEqual([{ path: 'P3/Hub.md', links: 2 }]);
      // P3.md didn't exist either (the test wrote P3/Plan.md directly), so both index notes are created.
      expect(out.parentsCreated).toEqual(['P3.md', 'P3/Archive.md']);
      expect(has('P3/Plan.md')).toBe(false);
      expect(get('P3/Hub.md')).toBe(
        'See [[P3/Archive/Plan#Goals|goals]] and [[P3/Archive/Plan]].\n'
      );

      const undone = await client.callTool({
        name: 'restore_note_version',
        arguments: { id: out.versionId }
      });
      expect(undone.structuredContent).toMatchObject({ path: 'P3/Plan.md', created: false });
      expect(get('P3/Plan.md')).toBe('The plan.\n');
      expect(get('P3/Hub.md')).toBe('See [[P3/Plan#Goals|goals]] and [[P3/Plan]].\n');
      await client.close();
    });

    it('move_note refuses an existing destination, and child notes unless includeChildren', async () => {
      put('P3/Taken.md', 'taken\n');
      put('P3/Team.md', 'Team index.\n');
      put('P3/Team/Ann.md', 'Ann. Up: [[P3/Team]].\n');
      const client = await makeClient(token);

      const taken = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Team.md', to: 'P3/Taken.md' }
      });
      expect(errorText(taken)).toContain('NOTE_ALREADY_EXISTS');

      const kids = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Team.md', to: 'P3/Crew.md' }
      });
      expect(errorText(kids)).toContain('HAS_CHILD_NOTES');
      expect(has('P3/Team.md')).toBe(true);

      const withKids = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Team.md', to: 'P3/Crew.md', includeChildren: true }
      });
      expect(withKids.structuredContent).toMatchObject({
        movedChildren: [{ from: 'P3/Team/Ann.md', to: 'P3/Crew/Ann.md' }]
      });
      expect(get('P3/Crew/Ann.md')).toBe('Ann. Up: [[P3/Crew]].\n');
      await client.close();
    });

    it('move_note is refused if any note whose links would change is out of scope or has unsaved edits', async () => {
      put('P3/Moving.md', 'm\n');
      put('P3/Fenced/Ref.md', '[[P3/Moving]]\n');
      const client = await makeClient(token);

      writeScope = { allow: [], deny: ['P3/Fenced'] };
      const scoped = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Moving.md', to: 'P3/Moved.md' }
      });
      expect(errorText(scoped)).toContain('PATH_NOT_IN_WRITE_SCOPE');

      writeScope = UNRESTRICTED_SCOPE;
      dirtyNotes.add('P3/Fenced/Ref.md');
      const dirty = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Moving.md', to: 'P3/Moved.md' }
      });
      expect(errorText(dirty)).toContain('NOTE_HAS_UNSAVED_EDITS');

      expect(has('P3/Moving.md')).toBe(true);
      expect(get('P3/Fenced/Ref.md')).toBe('[[P3/Moving]]\n');
      await client.close();
    });

    it('undoing a rename needs organize access', async () => {
      put('P3/Undo.md', 'u\n');
      const client = await makeClient(token);
      const moved = await client.callTool({
        name: 'move_note',
        arguments: { from: 'P3/Undo.md', to: 'P3/Undone.md' }
      });
      const { versionId } = moved.structuredContent as { versionId: string };
      await client.close();

      organizeEnabled = false;
      const limited = await makeClient(token);
      const refused = await limited.callTool({
        name: 'restore_note_version',
        arguments: { id: versionId }
      });
      expect(errorText(refused)).toContain('ORGANIZE_DISABLED');
      expect(has('P3/Undone.md')).toBe(true);
      await limited.close();
    });

    it('delete_note refuses a linked note unless forced, and the deletion can be restored', async () => {
      put('P3/Doomed.md', 'doomed\n');
      put('P3/Pointer.md', '[[P3/Doomed]]\n');
      const client = await makeClient(token);

      const refused = await client.callTool({
        name: 'delete_note',
        arguments: { path: 'P3/Doomed.md' }
      });
      expect(errorText(refused)).toContain('HAS_BACKLINKS');
      expect(errorText(refused)).toContain('P3/Pointer.md');

      const dry = await client.callTool({
        name: 'delete_note',
        arguments: { path: 'P3/Doomed.md', force: true, dryRun: true }
      });
      expect(dry.structuredContent).toMatchObject({ dryRun: true });
      expect(has('P3/Doomed.md')).toBe(true);

      const deleted = await client.callTool({
        name: 'delete_note',
        arguments: { path: 'P3/Doomed.md', force: true }
      });
      expect(deleted.structuredContent).toMatchObject({
        path: 'P3/Doomed.md',
        brokenLinksIn: ['P3/Pointer.md']
      });
      expect(has('P3/Doomed.md')).toBe(false);

      const { versionId } = deleted.structuredContent as { versionId: string };
      await client.callTool({ name: 'restore_note_version', arguments: { id: versionId } });
      expect(get('P3/Doomed.md')).toBe('doomed\n');
      await client.close();
    });

    it('get_daily_note resolves today, yesterday, tomorrow, and dates, and reports missing notes', async () => {
      put('2026-09-22.md', 'Yesterday entry.\n');
      const client = await makeClient(token);

      const yesterday = await client.callTool({
        name: 'get_daily_note',
        arguments: { date: 'yesterday' }
      });
      expect(yesterday.structuredContent).toMatchObject({
        date: '2026-09-22',
        path: '2026-09-22.md',
        exists: true,
        content: 'Yesterday entry.\n'
      });

      const tomorrow = await client.callTool({
        name: 'get_daily_note',
        arguments: { date: 'tomorrow' }
      });
      expect(tomorrow.structuredContent).toEqual({
        date: '2026-09-24',
        path: '2026-09-24.md',
        exists: false
      });

      const today = await client.callTool({ name: 'get_daily_note', arguments: {} });
      expect((today.structuredContent as { date: string }).date).toBe('2026-09-23');

      const bad = await client.callTool({
        name: 'get_daily_note',
        arguments: { date: '2026-02-30' }
      });
      expect(errorText(bad)).toContain('INVALID_ARGUMENT');
      await client.close();
    });
  });

  describe('cross-note read tools', () => {
    function errorText(result: unknown): string {
      return (result as { content: Array<{ text: string }> }).content[0].text;
    }
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
      fs.writeFileSync(path.join(vault, rel), text);
    };

    it('find_text finds every exact occurrence with line numbers, flags links, and proves absence', async () => {
      put(
        'FT/A.md',
        '---\ntitle: A\n---\nMet [[ann@corp.example]] today.\nEmail ann@corp.example later.\n'
      );
      put('FT/B.md', 'Nothing relevant.\nANN@CORP.EXAMPLE shouted.\n');
      const client = await makeClient(token);

      const all = await client.callTool({
        name: 'find_text',
        arguments: { query: 'ann@corp.example', folder: 'FT' }
      });
      expect(all.structuredContent).toMatchObject({
        totalMatches: 3,
        notesWithMatches: 2,
        notesSearched: 2,
        truncated: false,
        matches: [
          { path: 'FT/A.md', line: 4, column: 7, inLink: true },
          { path: 'FT/A.md', line: 5, column: 7, inLink: false },
          { path: 'FT/B.md', line: 2, column: 1, inLink: false }
        ]
      });

      const linksOnly = await client.callTool({
        name: 'find_text',
        arguments: { query: 'ann@corp.example', folder: 'FT', inLinks: 'only', caseSensitive: true }
      });
      expect((linksOnly.structuredContent as { totalMatches: number }).totalMatches).toBe(1);

      // After the fix, an empty, untruncated result is proof there are none left.
      put('FT/A.md', 'Met [[People/Ann]] today.\n');
      put('FT/B.md', 'Nothing relevant.\n');
      const none = await client.callTool({
        name: 'find_text',
        arguments: { query: 'ann@corp.example', folder: 'FT' }
      });
      expect(none.structuredContent).toMatchObject({
        totalMatches: 0,
        truncated: false,
        matches: []
      });
      await client.close();
    });

    it('find_text respects wholeWord and maxResults', async () => {
      put('FT2/W.md', 'Ann, Anne, Ann.\n');
      const client = await makeClient(token);
      const whole = await client.callTool({
        name: 'find_text',
        arguments: {
          query: 'Ann',
          folder: 'FT2',
          wholeWord: true,
          caseSensitive: true,
          maxResults: 1
        }
      });
      expect(whole.structuredContent).toMatchObject({ totalMatches: 2, truncated: true });
      expect((whole.structuredContent as { matches: unknown[] }).matches).toHaveLength(1);
      await client.close();
    });

    it('read_notes reads several notes at once and reports per-note errors', async () => {
      put('RN/One.md', 'one\n');
      put('RN/Two.md', 'two\n');
      const client = await makeClient(token);
      const result = await client.callTool({
        name: 'read_notes',
        arguments: { paths: ['RN/One.md', 'RN/Missing.md', 'RN/Two.md', '../escape.md'] }
      });
      const notes = (result.structuredContent as { notes: Array<Record<string, unknown>> }).notes;
      expect(notes.map((n) => [n.path, n.content ?? n.error])).toEqual([
        ['RN/One.md', 'one\n'],
        ['RN/Missing.md', 'NOTE_NOT_FOUND'],
        ['RN/Two.md', 'two\n'],
        ['../escape.md', 'PATH_NOT_ALLOWED']
      ]);
      expect(typeof notes[0].hash).toBe('string');
      await client.close();
    });

    it('lists unresolved links and gives backlinks for pages that do not exist', async () => {
      const saved = graph;
      put('UL/Note.md', 'x\n');
      put('UL/Sub/Child.md', 'y\n');
      graph = {
        ...saved,
        'UL/Note.md': ['bob@corp.example.md', 'People/Real.md', '2026.md'],
        'UL/Sub/Child.md': ['UL/Sub.md', 'bob@corp.example.md'],
        '2026.md': ['2026-09.md']
      };
      put('People/Real.md', 'real\n');
      try {
        const client = await makeClient(token);
        const unresolved = await client.callTool({
          name: 'list_unresolved_links',
          arguments: { folder: 'UL' }
        });
        // The virtual year node and Child's implicit link to its parent (UL/Sub.md) are skipped.
        expect(unresolved.structuredContent).toEqual({
          unresolved: [
            { target: 'bob@corp.example.md', linkedFrom: ['UL/Note.md', 'UL/Sub/Child.md'] }
          ],
          total: 1,
          truncated: false
        });

        const missing = await client.callTool({
          name: 'get_note_links',
          arguments: { path: 'bob@corp.example.md' }
        });
        expect(missing.structuredContent).toEqual({
          path: 'bob@corp.example.md',
          exists: false,
          outgoing: [],
          backlinks: ['UL/Note.md', 'UL/Sub/Child.md']
        });

        const nowhere = await client.callTool({
          name: 'get_note_links',
          arguments: { path: 'Nobody.md' }
        });
        expect(errorText(nowhere)).toContain('NOTE_NOT_FOUND');
        await client.close();
      } finally {
        graph = saved;
      }
    });
  });
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDeps } from './deps';
import { registerStatusTool } from './tools/status';
import { registerNoteTools } from './tools/notes';
import { registerSearchTool } from './tools/search';
import { registerTaskTools } from './tools/tasks';
import { registerGraphTools } from './tools/graph';
import { registerTagTools } from './tools/tags';

/** Builds a fresh, fully-configured MCP server. Called once per request in stateless mode. */
export function createPhosphorMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'phosphor-notes', version: deps.getAppVersion() });

  registerStatusTool(server, deps);
  registerNoteTools(server, deps);
  registerSearchTool(server, deps);
  registerTaskTools(server, deps);
  registerGraphTools(server, deps);
  registerTagTools(server, deps);

  return server;
}

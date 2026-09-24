import type { IncomingMessage, ServerResponse } from 'http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { extractBearerToken, verifyToken } from './auth';
import { isAllowedHost, isAllowedOrigin } from './guards';

export interface RequestListenerDeps {
  getTokenHash: () => string | null;
  getPort: () => number;
  buildServer: () => McpServer;
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MiB

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * The request pipeline for the local MCP endpoint, applied in order before
 * ever touching the SDK transport: exact-path check, Host/Origin validation
 * (see guards.ts - defense against DNS rebinding and any browser-originated
 * request, since this server must only ever be reached by native MCP
 * clients on localhost), then bearer-token auth. No CORS headers are ever
 * emitted, and the token is never accepted via the query string.
 */
export function createRequestListener(
  deps: RequestListenerDeps
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(req, res, deps).catch((err) => {
      console.error('[MCP] request handling failed:', err);
      if (!res.headersSent) {
        send(res, 500, 'Internal error');
      }
    });
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestListenerDeps
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://phosphor-mcp.internal');
  if (url.pathname !== '/mcp') {
    send(res, 404, 'Not found');
    return;
  }

  if (!isAllowedHost(req.headers.host, deps.getPort())) {
    send(res, 403, 'Forbidden: disallowed Host header');
    return;
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    send(res, 403, 'Forbidden: disallowed Origin header');
    return;
  }

  const tokenHash = deps.getTokenHash();
  const presented = extractBearerToken(req.headers.authorization);
  if (!tokenHash || !verifyToken(presented, tokenHash)) {
    send(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
    return;
  }

  const server = deps.buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: a fresh server+transport per request
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

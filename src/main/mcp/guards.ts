/**
 * Defense-in-depth header checks against DNS rebinding / browser-originated
 * requests. The MCP SDK's transport-level equivalents (`allowedHosts`,
 * `allowedOrigins`, `enableDnsRebindingProtection`) are deprecated in favor
 * of exactly this pattern: validating in front-of-transport middleware.
 */

/** True only for a Host header naming this loopback port - never a real hostname. */
export function isAllowedHost(hostHeader: string | string[] | undefined, port: number): boolean {
  const value = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!value) return false;
  const host = value.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * True when there's no Origin header at all. Native MCP clients (spawned
 * processes, the `mcp-remote` bridge) never send one; only a browser page
 * does. Since this server must never be reachable from a web page's
 * JavaScript, any Origin header at all - even one that looks local - is
 * rejected rather than checked against an allow-list.
 */
export function isAllowedOrigin(originHeader: string | string[] | undefined): boolean {
  return originHeader === undefined;
}

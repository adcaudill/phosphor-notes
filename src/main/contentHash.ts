import { createHmac, randomBytes } from 'crypto';

/**
 * Per-process secret for content hashes. A plain SHA-256 of a note would let
 * an MCP client that can see everything in the note *except* a redacted value
 * (e.g. an SSN, masked by `mcp/redact.ts`) brute-force that value offline -
 * there are only ~10^9 SSNs. Keying the hash with a secret that never leaves
 * this process makes it useless for that, while staying stable for the life
 * of the app, which is all an optimistic-concurrency token needs. (After an
 * app restart every hash changes, so a client holding an old one gets a
 * one-off NOTE_CHANGED and simply re-reads.)
 */
const SECRET = randomBytes(32);

/** Opaque version token for a note's full decrypted text, used as `expectedHash` by edit tools. */
export function contentHash(text: string): string {
  return createHmac('sha256', SECRET).update(text, 'utf8').digest('hex').slice(0, 32);
}

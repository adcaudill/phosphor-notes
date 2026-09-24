import { randomBytes, createHash, timingSafeEqual } from 'crypto';

const TOKEN_PREFIX = 'phos_';

/** Generates a new bearer token: 256 bits of randomness, base64url-encoded. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** Only the hash is ever persisted to disk - never the plaintext token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyToken(token: string | null, storedHash: string | null): boolean {
  if (!token || !storedHash) return false;
  const candidate = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/** Extracts the token from an `Authorization: Bearer <token>` header. Never reads it from a query string. */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

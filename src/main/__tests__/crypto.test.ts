import { describe, it, expect } from 'vitest';

describe('crypto module', () => {
  it('encrypt/decrypt roundtrip and isEncrypted detection', async () => {
    const crypto = await import('../crypto');

    const salt = crypto.generateSalt();
    const masterKey = crypto.deriveMasterKey('correct-horse', salt);

    const plain = Buffer.from('hello world');
    const blob = crypto.encryptBuffer(plain, masterKey);

    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(crypto.isEncrypted(blob)).toBe(true);

    const out = crypto.decryptBuffer(blob, masterKey);
    expect(out.toString('utf-8')).toBe('hello world');
  });

  it('decrypt throws for invalid blob or wrong key', async () => {
    const crypto = await import('../crypto');

    // invalid blob
    expect(() => crypto.decryptBuffer(Buffer.from('nope'), Buffer.alloc(32))).toThrow();

    // wrong key
    const salt = crypto.generateSalt();
    const masterKey = crypto.deriveMasterKey('one-password', salt);
    const otherKey = crypto.deriveMasterKey('different-password', salt);

    const plain = Buffer.from('secret');
    const blob = crypto.encryptBuffer(plain, masterKey);

    expect(() => crypto.decryptBuffer(blob, otherKey)).toThrow();
  });

  it('deriveMasterKey is deterministic for same password+salt', async () => {
    const crypto = await import('../crypto');
    const salt = crypto.generateSalt();
    const a = crypto.deriveMasterKey('p@ssw0rd', salt);
    const b = crypto.deriveMasterKey('p@ssw0rd', salt);
    expect(a.equals(b)).toBe(true);
  });

  it('throws Content decryption failed when ciphertext is tampered', async () => {
    const crypto = await import('../crypto');
    const salt = crypto.generateSalt();
    const masterKey = crypto.deriveMasterKey('hunter2', salt);

    const plain = Buffer.from('important secret');
    const blob = crypto.encryptBuffer(plain, masterKey);

    // Corrupt one byte in the ciphertext portion (towards end)
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;

    expect(() => crypto.decryptBuffer(tampered, masterKey)).toThrow('Content decryption failed');
  });
});

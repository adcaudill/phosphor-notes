import sodium from 'sodium-native';

// Constants
const HEADER_MAGIC = Buffer.from('PHOS01'); // Magic bytes + Version 1
const SALT_SIZE = sodium.crypto_pwhash_SALTBYTES;
const KEY_SIZE = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const NONCE_SIZE = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const MAC_SIZE = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): Buffer {
  const salt = Buffer.allocUnsafe(SALT_SIZE);
  sodium.randombytes_buf(salt);
  return salt;
}

/**
 * Derive a Master Key from password using Argon2id
 * High memory cost to make GPU cracking expensive
 */
export function deriveMasterKey(password: string, salt: Buffer): Buffer {
  const masterKey = Buffer.allocUnsafe(KEY_SIZE);
  const passwordBuf = Buffer.from(password);

  try {
    sodium.crypto_pwhash(
      masterKey,
      passwordBuf,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );
  } finally {
    // Wipe password from memory immediately
    sodium.sodium_memzero(passwordBuf);
  }

  return masterKey;
}

/**
 * Encrypt a buffer using the Master Key
 * Uses envelope encryption: file gets its own random key, which is then wrapped with the master key
 */
export function encryptBuffer(content: Buffer, masterKey: Buffer): Buffer {
  // A. Generate a random key for THIS specific file
  const fileKey = Buffer.allocUnsafe(KEY_SIZE);
  sodium.randombytes_buf(fileKey);

  // B. Encrypt the Content using the File Key
  const contentNonce = Buffer.allocUnsafe(NONCE_SIZE);
  sodium.randombytes_buf(contentNonce);

  const cipherText = Buffer.allocUnsafe(content.length + MAC_SIZE);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    cipherText,
    content,
    null,
    null,
    contentNonce,
    fileKey
  );

  // C. Wrap (Encrypt) the File Key using the Master Key
  const keyNonce = Buffer.allocUnsafe(NONCE_SIZE);
  sodium.randombytes_buf(keyNonce);

  const encryptedFileKey = Buffer.allocUnsafe(KEY_SIZE + MAC_SIZE);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    encryptedFileKey,
    fileKey,
    null,
    null,
    keyNonce,
    masterKey
  );

  // D. Construct the Blob
  // [MAGIC 6b] [KeyNonce 24b] [EncryptedFileKey 48b] [ContentNonce 24b] [CipherText ...]
  const blob = Buffer.concat([HEADER_MAGIC, keyNonce, encryptedFileKey, contentNonce, cipherText]);

  // Clean up secrets
  sodium.sodium_memzero(fileKey);

  return blob;
}

/**
 * Decrypt a buffer using the Master Key
 */
export function decryptBuffer(blob: Buffer, masterKey: Buffer): Buffer {
  // Check Magic
  if (!blob.subarray(0, 6).equals(HEADER_MAGIC)) {
    throw new Error('Invalid file format or unencrypted file');
  }

  let cursor = 6;

  // A. Extract Wrapped Key Data
  const keyNonce = blob.subarray(cursor, cursor + NONCE_SIZE);
  cursor += NONCE_SIZE;

  const encryptedFileKey = blob.subarray(cursor, cursor + KEY_SIZE + MAC_SIZE);
  cursor += KEY_SIZE + MAC_SIZE;

  // B. Unwrap the File Key
  const fileKey = Buffer.allocUnsafe(KEY_SIZE);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      fileKey,
      null,
      encryptedFileKey,
      null,
      keyNonce,
      masterKey
    );
  } catch {
    sodium.sodium_memzero(fileKey);
    throw new Error('Decryption failed: Wrong Password?');
  }

  // C. Extract Content Data
  const contentNonce = blob.subarray(cursor, cursor + NONCE_SIZE);
  cursor += NONCE_SIZE;

  const cipherText = blob.subarray(cursor);
  const plainText = Buffer.allocUnsafe(cipherText.length - MAC_SIZE);

  // D. Decrypt Content
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plainText,
      null,
      cipherText,
      null,
      contentNonce,
      fileKey
    );
  } catch {
    sodium.sodium_memzero(fileKey);
    throw new Error('Content decryption failed');
  }

  sodium.sodium_memzero(fileKey);

  return plainText;
}

/**
 * Check if a buffer is encrypted (starts with magic header)
 */
export function isEncrypted(buffer: Buffer): boolean {
  if (buffer.length < 6) return false;
  return buffer.subarray(0, 6).equals(HEADER_MAGIC);
}

---
title: "File Encryption"
layout: home
parent: "Technical Notes"
---

**Overview**

- **What:** When a vault is configured for encryption, Phosphor encrypts note files and assets on disk so they are stored ciphertext-first and only decrypted in memory when the vault is unlocked.
- **Where:** Vault encryption settings are stored at `.phosphor/security.json` inside the vault folder.

**How keys are derived and stored**

- A password provided by the user is turned into a persistent vault secret using Argon2id (libsodium's `crypto_pwhash`). A random salt is generated with `generateSalt()` and saved (base64) in `.phosphor/security.json`.
- The derived Master Key is kept only in process memory while the vault is unlocked (`activeMasterKey`). It is wiped from memory when the vault is locked or the app switches vaults.
- A small encrypted "check token" (also saved in `.phosphor/security.json`) is used to verify the password during unlock without exposing any plaintext on disk.

**Per-file encryption (envelope encryption)**

- Files are encrypted using an envelope scheme:
  - Each file (or asset) gets its own random file key.
  - The file content is encrypted with that file key using XChaCha20-Poly1305 AEAD.
  - The file key itself is encrypted (wrapped) with the Master Key using XChaCha20-Poly1305 AEAD.
- This means the Master Key never encrypts arbitrarily large file blobs directly and per-file keys protect individual files.
- Nonces and authentication tags (MACs) are used for both the file content and the wrapped file key.

**On-disk format**

- Encrypted files begin with a 6-byte magic header: the ASCII string `PHOS01` (magic + version).
- After the header the raw blob layout is:

  [HEADER_MAGIC (6 bytes)] [key nonce] [encrypted file key (key+mac)] [content nonce] [ciphertext]

- The code uses libsodium constants for sizes (salt, key, nonce, MAC) so exact byte sizes follow libsodium's XChaCha20-Poly1305 and pwhash definitions.

**Detection and decryption**

- Files are detected as encrypted by checking for the `PHOS01` header. The helper `isEncrypted(buffer)` implements this check.
- When the vault is unlocked, Phosphor stores the Master Key in memory and will decrypt files on demand using `decryptBuffer(...)`. If an incorrect password is used, decryption of the stored check token fails and unlocking is rejected.
- Tampering with ciphertext or using the wrong key results in AEAD failures; the code surfaces an error such as "Content decryption failed" or a generic decryption failure.

**Application behavior**

- When encryption is enabled (`encryption:create`), a salt and encrypted check token are written to `.phosphor/security.json`, the vault is unlocked, and existing notes/assets are encrypted via `encryptAllNotes`.
- When unlocking (`encryption:unlock`) the app derives the Master Key from the given password and attempts to decrypt the check token; if successful the Master Key is stored in memory and the app will:
  - Scan the vault and auto-encrypt any detected unencrypted files (`scanAndEncryptUnencryptedFiles`).
  - Re-index the vault so decrypted content is available to the in-memory indexer.
- When saving notes or assets while a vault is unlocked, the app encrypts the bytes before writing them to disk. When reading, if the buffer is encrypted and the vault is unlocked, it is decrypted before returning text to the renderer.
- Asset handling: encrypted assets are decrypted to a temporary file before opening with the OS.

**Security considerations implemented in code**

- Passwords and temporary keys are explicitly zeroed from memory after use (libsodium's `sodium_memzero`).
- The implementation uses Argon2id via libsodium's `crypto_pwhash` (the code uses the interactive ops/mem limits) and XChaCha20-Poly1305 AEAD for authenticated encryption.
- The Master Key lives only in process memory while unlocked and is cleared on lock/quit/vault switch.

**Practical notes for users**

- If you forget the vault password, there is no way to recover the Master Key — encrypted files are not recoverable without it.
- Back up your vault (including its `.phosphor/security.json`) before making bulk changes.
- Enabling encryption will cause Phosphor to re-write files in the vault as encrypted blobs — this operation is done in-place, so ensure you have a backup if you rely on external sync services.

**Where to look in the code**

- Core crypto helpers: `src/main/crypto.ts` (`generateSalt`, `deriveMasterKey`, `encryptBuffer`, `decryptBuffer`, `isEncrypted`).
- Vault encryption management and IPC handlers: `src/main/ipc.ts` (security.json management, `encryption:create`, `encryption:unlock`, auto-encrypt/scan, and read/save handlers that encrypt/decrypt on disk).

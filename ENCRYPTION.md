# Phosphor Notes: Encryption Architecture

A detailed technical specification of the zero-knowledge encryption model used in Phosphor Notes.

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Design Goals and Threat Model](#design-goals-and-threat-model)
3. [Cryptographic Primitives](#cryptographic-primitives)
4. [Architecture](#architecture)
5. [Key Derivation](#key-derivation)
6. [File Encryption Format](#file-encryption-format)
7. [Security Analysis](#security-analysis)
8. [Implementation Details](#implementation-details)
9. [Comparison with Alternatives](#comparison-with-alternatives)
10. [Limitations and Future Work](#limitations-and-future-work)

---

## Executive Summary

Phosphor Notes implements **zero-knowledge encryption** using industry-standard cryptographic primitives. The design follows the architecture of established tools like KeePassXC and FileVault, with particular emphasis on:

- **Key isolation**: Per-file encryption keys, each independent
- **Master key transience**: Master key exists only in process memory; discarded on application termination
- **No password storage**: Passwords are used only for key derivation, never stored
- **Envelope encryption**: File keys are wrapped with the master key, allowing password changes without re-encrypting the entire vault
- **Authenticated encryption**: All ciphertext includes authentication tags, preventing tampering

The system does **not** claim to provide:

- Protection against keyloggers or screen capture (application-level threats)
- Time-travel security (once the application closes, the key is gone)
- Mobile/web synchronization security (out of scope)
- Protection if the filesystem itself is compromised while the vault is unlocked

---

## Design Goals and Threat Model

### Primary Goals

1. **Confidentiality**: File contents are inaccessible without the correct password
2. **Integrity**: Tampering with encrypted files is detectable
3. **Usability**: The user need only remember a single password
4. **Flexibility**: Files can be renamed or moved without decryption/re-encryption
5. **Password changes**: Changing the master password should not require re-encrypting all files

### Threat Model

**Adversaries we protect against:**

- Attackers with read access to the filesystem (disk image, cloud backup, stolen laptop with disk encrypted at rest)
- Attackers attempting to brute-force passwords (Argon2id makes this expensive)
- Attackers attempting to tamper with files (authentication tags detect changes)

**Adversaries we do NOT protect against:**

- Attackers with process-level access while the application is running (can read memory)
- Keyloggers or input monitoring devices
- Side-channel attacks on the cryptographic implementation
- Malware running with the same privileges as the application
- Forensic analysis of process memory after encryption key extraction

---

## Cryptographic Primitives

### 1. Key Derivation Function (KDF): Argon2id

**Function**: `crypto_pwhash` from libsodium

**Parameters**:

```
OPSLIMIT_INTERACTIVE = 4        # Memory-hard iterations
MEMLIMIT_INTERACTIVE = 67108864 # 64 MiB memory cost
ALG = ARGON2ID13                # Argon2id variant
```

**Rationale**:

- **Argon2id** won the Password Hashing Competition (2015) for its resistance to GPU and ASIC attacks
- **Memory-hard design**: Requires 64 MB of RAM per operation, making parallel attacks expensive
- **Time cost**: 4 iterations, tuned for interactive latency (~1 second on modern hardware)
- **Salt**: 16 random bytes, stored in plaintext in `.phosphor/security.json`

**Security properties**:

- Resistant to rainbow tables and dictionary attacks
- GPU cracking costs ~$1.5 per guess for consumer hardware
- ASIC resistance due to memory bandwidth requirements

### 2. Authenticated Encryption: XChaCha20-Poly1305

**Function**: `crypto_aead_xchacha20poly1305_ietf` from libsodium

**Parameters**:

```
Key size:    32 bytes (256 bits)
Nonce size:  24 bytes (192 bits)
Tag size:    16 bytes (128 bits)
```

**Rationale**:

- **ChaCha20**: Stream cipher with simple, secure design; resistant to timing attacks
- **Poly1305**: Polynomial MAC, one-time-use authentication
- **IETF variant**: Uses industry-standard construction
- **XChaCha20**: Extended 24-byte nonce eliminates collision risk in high-volume scenarios
  - Standard ChaCha20 has 12-byte nonce → collision at ~2^32 encryptions
  - XChaCha20 has 24-byte nonce → collision at ~2^96 encryptions (negligible risk)

**Security properties**:

- Confidentiality: 256-bit against brute force
- Integrity: 128-bit (2^-128 probability of forgery with unknown key)
- Authenticated encryption: Ensures ciphertext and metadata integrity
- Nonce misuse resistance: While using random nonces, a single collision does not compromise security

### 3. Random Number Generation

**Function**: `randombytes_buf` from libsodium

**Implementation**: Uses `/dev/urandom` on Unix-like systems, cryptographically secure RNG on Windows

**Usage**:

- Vault salt: 16 random bytes
- File keys: 32 random bytes per file
- Nonces: 24 random bytes per encryption operation

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────┐
│                    User Password                        │
│                   "hunter2password"                     │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ├─ Loaded from user input
                       ├─ Wiped from memory after KDF
                       └─ Never stored or logged
                       │
                       v
┌─────────────────────────────────────────────────────────┐
│   Argon2id KDF (64 MiB, 4 iterations) + Vault Salt     │
└──────────────────────┬──────────────────────────────────┘
                       │
                       └─ Outputs 32-byte Master Key
                       │
                       v
┌─────────────────────────────────────────────────────────┐
│              Master Key (Process Memory)                │
│         - Stored only in process RAM                    │
│         - Cleared on application termination            │
│         - Used to wrap/unwrap file keys                 │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
         v             v             v
    ┌────────┐    ┌────────┐    ┌────────┐
    │File A  │    │File B  │    │Image C │
    │ Key    │    │ Key    │    │ Key    │
    └───┬────┘    └───┬────┘    └───┬────┘
        │             │             │
        └─────────────┼─────────────┘
                      │
         (Each file key independently wrapped)
                      │
                      v
┌─────────────────────────────────────────────────────────┐
│     Encrypted File Keys + Content (Disk Storage)        │
│     [PHOS01][KeyNonce][EncryptedFileKey][Content...]    │
└─────────────────────────────────────────────────────────┘
```

### Key Lifecycle

1. **Vault Creation**:
   - User enters new password
   - Random 16-byte salt generated
   - Argon2id(password, salt) → Master Key
   - Test encryption created with random data
   - Salt + encrypted test data written to `.phosphor/security.json`
   - Master Key stored in process memory

2. **Vault Opening** (After restart):
   - `.phosphor/security.json` loaded (contains salt + encrypted test data)
   - User enters password
   - Argon2id(password, salt) → Master Key candidate
   - Master Key candidate used to decrypt test data
   - On success: Master Key stored in process memory
   - On failure: Error message, try again

3. **File Write**:
   - New file key generated (32 random bytes)
   - File content encrypted with file key via XChaCha20-Poly1305
   - File key wrapped (encrypted) using Master Key
   - Blob written to disk: [Header][WrappedKey][EncryptedContent]

4. **File Read**:
   - Blob read from disk
   - Header verified (magic bytes)
   - Wrapped key decrypted using Master Key → File key
   - File content decrypted using file key → Plaintext
   - Plaintext returned to application

5. **Vault Lock** (Application termination):
   - Master Key overwritten with zeros using `sodium_memzero()`
   - Application exits
   - Process memory released by OS

---

## Key Derivation

### Salt Storage

The vault salt is stored in plaintext within `.phosphor/security.json`:

```json
{
  "salt": "base64-encoded-16-bytes",
  "checkToken": "base64-encoded-encrypted-test-string"
}
```

**Rationale for plaintext salt**:

- Salts are not secret; their purpose is to prevent rainbow tables
- Plaintext storage allows offline password verification and cross-platform portability
- Hiding the salt provides no additional security benefit

### Check Token

To verify password correctness without storing the plaintext, a known-plaintext authentication is performed:

```
plaintext = "phosphor-vault-check-token"
checkToken = XChaCha20-Poly1305(plaintext, masterKey, randomNonce)
```

**Unlock procedure**:

1. Load salt and checkToken from `.phosphor/security.json`
2. Derive candidate Master Key: `Argon2id(password, salt)`
3. Attempt decryption: `plaintext = XChaCha20-Poly1305_decrypt(checkToken, masterKey)`
4. If decryption succeeds and plaintext matches expected value → password correct
5. If decryption fails or plaintext mismatches → password incorrect

**Security properties**:

- No information about password correctness is leaked if decryption fails
- An attacker cannot verify guesses without the original ciphertext
- The checkToken prevents accidental lockouts due to bit-flip corruption

---

## File Encryption Format

### Blob Structure

Each encrypted file follows a strict binary format:

```
┌─────────────────┬──────────────┬─────────────────┬──────────────┬────────────┐
│  PHOS01 Header  │  Key Nonce   │ Encrypted Key   │ Content Nonce│ Ciphertext │
│  (6 bytes)      │  (24 bytes)  │ + MAC (48 bytes)│ (24 bytes)   │ (variable) │
└─────────────────┴──────────────┴─────────────────┴──────────────┴────────────┘
```

### Detailed Breakdown

#### 1. Magic Header (6 bytes)

```
[0x50, 0x48, 0x4F, 0x53, 0x30, 0x31] = "PHOS01"
```

- Identifies file as Phosphor-encrypted
- Version byte (01) allows future format changes
- Prevents accidental interpretation of encrypted data as plaintext

#### 2. Key Wrapping Section

**Key Nonce (24 bytes)**:

- Randomly generated for each file encryption
- Ensures nonce never repeats for the same Master Key
- Stored in plaintext (nonce reuse, not secrecy, is the concern)

**Encrypted File Key (48 bytes)**:

- 32 bytes: Original file key
- 16 bytes: Poly1305 authentication tag
- Encrypted using: `XChaCha20-Poly1305(fileKey, masterKey, keyNonce)`
- Decryption requires knowledge of Master Key

#### 3. Content Encryption Section

**Content Nonce (24 bytes)**:

- Randomly generated for each file encryption
- Independent of key nonce
- Ensures content and key use different nonces

**Ciphertext + MAC (variable)**:

- Original plaintext size: variable
- Output size: plaintext_length + 16 bytes (MAC)
- Encrypted using: `XChaCha20-Poly1305(content, fileKey, contentNonce)`
- Modification detected via Poly1305 tag verification

### Example Decryption Flow

```typescript
// Input: encrypted blob
const blob = Buffer.from([...]);

// Extract sections
const header = blob.slice(0, 6);                    // "PHOS01"
const keyNonce = blob.slice(6, 30);                // 24 bytes
const encryptedKey = blob.slice(30, 78);           // 48 bytes
const contentNonce = blob.slice(78, 102);          // 24 bytes
const ciphertext = blob.slice(102);                // Rest

// Unwrap file key using master key
const fileKey = decrypt(
  encryptedKey,
  null,           // No additional data
  keyNonce,
  masterKey
);

// Decrypt content using file key
const plaintext = decrypt(
  ciphertext,
  null,           // No additional data
  contentNonce,
  fileKey
);

// Return plaintext
return plaintext;
```

---

## Security Analysis

### Confidentiality Analysis

**Threat**: Attacker obtains encrypted file blobs

**Protection**:

- XChaCha20-Poly1305 provides 256-bit confidentiality
- Each file has independent key, limiting exposure
- Password-derived Master Key requires Argon2id break (computationally infeasible)

**Security level**: 256 bits against brute force

### Integrity Analysis

**Threat**: Attacker modifies encrypted file blob

**Detection**:

- Poly1305 MAC on both file key and content
- Modification of any byte detected with probability 2^-128

**Guarantee**: Modification detected with overwhelming probability

### Authentication Analysis

**Threat**: Attacker attempts password guessing without hardware access

**Cost analysis**:

- Single Argon2id derivation: ~1 second on modern hardware
- Memory requirement: 64 MB per attempt
- GPU optimization: Difficult due to memory bandwidth
- Estimated cost: $1.50 per guess (consumer GPU cluster)
- Entropy for strong password (12 random chars): ~78 bits
- Expected guesses before success: 2^77 (infeasible)

**Mitigation**: Strong passwords (15+ characters) effectively eliminate guessing risk

### Nonce Collision Analysis

**Risk**: Reusing a nonce with the same key breaks XChaCha20

**Prevention**:

- All nonces generated from cryptographically secure RNG
- Collision probability with 2^32 encryptions: ~2^-96 (negligible)
- Even with 1 billion files encrypted with same key: negligible collision risk

**Guarantee**: Single-use nonce assumption holds with overwhelming probability

### Key Derivation Analysis

**Threat**: Offline dictionary attack against vault salt

**Defense mechanisms**:

1. High memory cost (64 MB):
   - Makes parallelization expensive
   - GPU cluster attack scales poorly (memory bandwidth limited)
2. High iteration count (4 passes):
   - Slows single-threaded attacks
   - Tuned for ~1 second per guess
3. Argon2id winner of PHC:
   - Specifically designed for password hashing
   - Resistant to cache-timing attacks
   - Designed to be hard on GPUs/ASICs

**Conclusion**: Brute-force attacks are computationally expensive but not theoretically impossible. Password strength is critical.

### Forward Secrecy

**Question**: If Master Key is compromised, is historical data at risk?

**Answer**: Yes, all files are at risk. However:

- File keys are only known by Master Key holder
- Historical Master Key access requires password guess (expensive)
- This is expected behavior for envelope encryption

**Mitigation**: Regular password changes with new file key wrapping (future feature)

---

## Implementation Details

### Memory Management

All sensitive data is wiped using `sodium_memzero()`:

```typescript
// After key derivation
sodium.sodium_memzero(passwordBuffer);

// After file encryption/decryption
sodium.sodium_memzero(fileKey);

// On vault lock
sodium.sodium_memzero(masterKey);
```

**Properties of `sodium_memzero()`**:

- Implemented without optimizer-removable dead store elimination
- Guaranteed to overwrite all bytes (not optimized away)
- MSVC, GCC, Clang all respect this
- Fills with zeros (all bits set to 0)

**Limitations**:

- Does not prevent processor cache residue
- Does not prevent speculative execution leaks
- Does not prevent memory swap (if swap is enabled)

### Error Handling

**Decryption failures** are reported generically:

- "Decryption failed" without revealing which step (key unwrap vs. content decrypt)
- No information leakage about password correctness vs. file corruption

**File format errors** are caught early:

- Magic header check on all encrypted reads
- Prevents interpretation of partially-corrupted files

### Backwards Compatibility

**Unencrypted files** (no magic header):

- Detected via absence of `PHOS01` magic bytes
- Read directly without decryption
- Coexist with encrypted files in same vault

**Mixed vaults** (some files encrypted, some not):

- Fully supported
- Encrypted files require unlocked vault
- Unencrypted files always accessible

---

## Comparison with Alternatives

### vs. File-Level Encryption (AES-256-GCM per file, derived from filename)

**Phosphor approach advantages**:

- ✅ Envelope encryption allows password changes
- ✅ Independent nonces per file
- ✅ File renaming doesn't corrupt data
- ✅ Strong password hashing (Argon2id)

**Traditional approach advantages**:

- Simpler implementation
- No per-vault metadata needed

### vs. Full Disk Encryption (BitLocker, FileVault)

**Phosphor advantages**:

- ✅ Application-level control
- ✅ Cross-platform
- ✅ Per-vault granularity
- ✅ Portable encrypted archives

**FDE advantages**:

- Encrypted while application not running
- Better performance
- Transparent to applications

### vs. Client-Server E2EE (iCloud Keychain, ProtonMail)

**Phosphor advantages**:

- ✅ No central server required
- ✅ No network trust assumptions
- ✅ Works offline
- ✅ No account dependencies

**Client-Server advantages**:

- Sync across devices
- Cloud backup integration
- Account-level key recovery

---

## Limitations and Future Work

### Known Limitations

1. **Process memory exposure**:
   - If application is compromised by malware, keys are accessible
   - No protection against kernel-level attacks
   - Mitigation: Use a separate encrypted partition for vault

2. **Swap file exposure**:
   - On systems with swap enabled, keys may be written to disk
   - Mitigation: Disable swap or use encrypted swap

3. **No key rotation**:
   - Current implementation: all files share Master Key
   - Compromise of Master Key affects all files
   - Mitigation: Full re-encryption with new password (future feature)

4. **No partial encryption**:
   - All or nothing: either vault is encrypted or it isn't
   - Cannot selectively encrypt individual files
   - Mitigation: Create separate vaults for different sensitivity levels

5. **No password hints**:
   - Failed unlock reveals nothing about password correctness
   - User must remember password exactly
   - Mitigation: Use password manager

### Future Enhancements

1. **Multi-user vaults** (Phase 5):
   - Encrypt master key using multiple passwords (Shamir's Secret Sharing)
   - Allow different encryption for different users

2. **Automatic key rotation**:
   - Periodically re-wrap file keys with new Master Key
   - Enables password changes without re-encrypting content

3. **Encrypted metadata**:
   - Currently file modification times and sizes are visible
   - Could encrypt even this metadata in future version

4. **Mobile support**:
   - Current: Electron desktop only
   - Future: Native iOS/Android with different threat model

5. **Benchmark tool**:
   - Measure Argon2id performance on user hardware
   - Auto-tune KDF parameters for target latency

6. **Hardware key support**:
   - FIDO2/YubiKey integration for Master Key derivation
   - Higher security for high-risk users

---

## References

- **Argon2**: [Password Hashing Competition Winner](https://password-hashing.info/)
- **ChaCha20-Poly1305**: [RFC 7539](https://tools.ietf.org/html/rfc7539)
- **libsodium**: [libsodium.org](https://libsodium.org/)
- **KeePassXC**: [Database format reference](https://keepass.info/)
- **FileVault 2**: [Apple security documentation](https://support.apple.com/en-us/HT204837)

---

## Acknowledgments

This encryption architecture is based on established best practices from:

- KeePassXC database encryption model
- Apple FileVault 2
- The Password Hashing Competition
- libsodium cryptographic library

The design prioritizes simplicity and auditability over theoretical perfection, following the principle that "simple crypto is harder to break than complex crypto."

---

**Last updated**: January 2026

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import {
  validateAndResolvePath,
  resolveReadableNotePath,
  resolveReadableFolderPath,
  resolveWritableNotePath,
  PathNotAllowedError
} from '../vaultPaths';

describe('validateAndResolvePath (GUI-facing guard)', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-test-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('allows nested paths within the vault', () => {
    const resolved = validateAndResolvePath(vault, 'People/John.md');
    expect(resolved).toBe(path.join(vault, 'People', 'John.md'));
  });

  it('rejects parent traversal', () => {
    expect(() => validateAndResolvePath(vault, '../../../etc/passwd')).toThrow(
      'Path traversal attempt detected'
    );
  });
});

describe('resolveReadableNotePath (MCP-facing strict guard)', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-test-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('allows a nested existing note', async () => {
    fs.mkdirSync(path.join(vault, 'People'));
    fs.writeFileSync(path.join(vault, 'People', 'John.md'), 'hi');

    const resolved = await resolveReadableNotePath(vault, 'People/John.md');
    expect(resolved).toBe(path.join(vault, 'People', 'John.md'));
  });

  it('allows a path to a not-yet-existing note (caller reports not-found)', async () => {
    const resolved = await resolveReadableNotePath(vault, 'missing.md');
    expect(resolved).toBe(path.join(vault, 'missing.md'));
  });

  const rejected: Array<[string, string]> = [
    ['../x.md', 'parent traversal'],
    ['a/../../x.md', 'parent traversal'],
    ['/etc/passwd', 'absolute path'],
    ['.phosphor/security.json', 'hidden path segment'],
    ['.git/config', 'hidden path segment'],
    ['foo.txt', 'wrong extension'],
    ['foo.md.bak', 'backup file'],
    ['', 'empty path']
  ];

  it.each(rejected)('rejects %s (%s)', async (input) => {
    await expect(resolveReadableNotePath(vault, input)).rejects.toThrow(PathNotAllowedError);
  });

  it('rejects a NUL byte in the path', async () => {
    await expect(resolveReadableNotePath(vault, 'a\0b.md')).rejects.toThrow(PathNotAllowedError);
  });

  it('treats percent-encoded traversal literally, rejecting it as a leading-dot segment rather than decoding it into a real traversal', async () => {
    // '..%2Fsecret.md' is never decoded, so it's read as one literal filename
    // segment. It's rejected by the leading-dot rule (the same rule that
    // blocks '.phosphor/x.md') rather than being decoded into '../secret.md'
    // and escaping some other way - the important property is that decoding
    // never happens, not that this exact input is allowed through.
    await expect(resolveReadableNotePath(vault, '..%2Fsecret.md')).rejects.toThrow(
      PathNotAllowedError
    );
  });

  it('rejects a symlink inside the vault that points outside it', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-outside-'));
    try {
      const secretPath = path.join(outsideDir, 'secret.md');
      fs.writeFileSync(secretPath, 'top secret');

      const linkPath = path.join(vault, 'link.md');
      fs.symlinkSync(secretPath, linkPath);

      await expect(resolveReadableNotePath(vault, 'link.md')).rejects.toThrow(PathNotAllowedError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows a symlink that stays within the vault', async () => {
    fs.writeFileSync(path.join(vault, 'real.md'), 'content');
    fs.symlinkSync(path.join(vault, 'real.md'), path.join(vault, 'alias.md'));

    // The symlink path itself is returned (readFile will follow it); the
    // point of this test is that it's *not* rejected as escaping the vault.
    const resolved = await resolveReadableNotePath(vault, 'alias.md');
    expect(resolved).toBe(path.join(vault, 'alias.md'));
  });
});

describe('resolveReadableFolderPath', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-test-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('resolves to the vault root when no folder is given', async () => {
    const resolved = await resolveReadableFolderPath(vault);
    expect(resolved).toBe(path.resolve(vault));
  });

  it('resolves a nested existing folder', async () => {
    fs.mkdirSync(path.join(vault, 'People'));
    const resolved = await resolveReadableFolderPath(vault, 'People');
    expect(resolved).toBe(path.join(vault, 'People'));
  });

  it('rejects a hidden folder', async () => {
    await expect(resolveReadableFolderPath(vault, '.phosphor')).rejects.toThrow(
      PathNotAllowedError
    );
  });
});

describe('resolveWritableNotePath (write-facing strict guard)', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-test-'));
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('allows a normal new nested path (no file or directory exists yet)', async () => {
    const resolved = await resolveWritableNotePath(vault, 'Projects/Foo/Bar.md');
    expect(resolved).toBe(path.join(vault, 'Projects', 'Foo', 'Bar.md'));
  });

  it('allows writing to an existing plain file', async () => {
    fs.writeFileSync(path.join(vault, 'existing.md'), 'hi');
    const resolved = await resolveWritableNotePath(vault, 'existing.md');
    expect(resolved).toBe(path.join(vault, 'existing.md'));
  });

  it('rejects writing to a symlinked note, even one pointing inside the vault', async () => {
    fs.writeFileSync(path.join(vault, 'real.md'), 'content');
    fs.symlinkSync(path.join(vault, 'real.md'), path.join(vault, 'alias.md'));

    await expect(resolveWritableNotePath(vault, 'alias.md')).rejects.toThrow(PathNotAllowedError);
  });

  it('rejects a dangling symlink target pointing outside the vault', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-outside-'));
    try {
      // The symlink target does not exist, so a naive "ENOENT -> allow" check
      // (correct for reads) would let a write follow it out of the vault.
      const danglingTarget = path.join(outsideDir, 'not-created-yet.md');
      fs.symlinkSync(danglingTarget, path.join(vault, 'dangling.md'));

      await expect(resolveWritableNotePath(vault, 'dangling.md')).rejects.toThrow(
        PathNotAllowedError
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked parent directory pointing outside the vault', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vaultpaths-outside-'));
    try {
      fs.symlinkSync(outsideDir, path.join(vault, 'Linked'));

      // The target file itself doesn't exist, so resolution has to walk up
      // to "Linked/" (the nearest existing ancestor) and notice *that* is a
      // symlink escaping the vault, rather than stopping at the file's ENOENT.
      await expect(resolveWritableNotePath(vault, 'Linked/New.md')).rejects.toThrow(
        PathNotAllowedError
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

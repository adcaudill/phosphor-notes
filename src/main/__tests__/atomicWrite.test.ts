import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import os from 'os';
import { writeFileAtomic } from '../atomicWrite';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-atomic-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new file', async () => {
    const target = path.join(dir, 'note.md');
    await writeFileAtomic(target, 'hello\n');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello\n');
  });

  it('replaces an existing file and leaves no temp files behind', async () => {
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, 'old\n');
    await writeFileAtomic(target, Buffer.from('new\n'));
    expect(fs.readFileSync(target, 'utf-8')).toBe('new\n');
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('exclusive mode refuses to clobber an existing file', async () => {
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, 'keep me\n');
    await expect(writeFileAtomic(target, 'nope', { exclusive: true })).rejects.toMatchObject({
      code: 'EEXIST'
    });
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('exclusive mode creates a missing file', async () => {
    const target = path.join(dir, 'fresh.md');
    await writeFileAtomic(target, 'x', { exclusive: true });
    expect(fs.readFileSync(target, 'utf-8')).toBe('x');
    expect(fs.readdirSync(dir)).toEqual(['fresh.md']);
  });

  it('leaves the original untouched and cleans up when the rename fails', async () => {
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, 'original\n');
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('boom'), { code: 'EXDEV' }));
    await expect(writeFileAtomic(target, 'replacement')).rejects.toThrow('boom');
    expect(fs.readFileSync(target, 'utf-8')).toBe('original\n');
    expect(fs.readdirSync(dir)).toEqual(['note.md']);
  });

  it('retries a transient rename error (e.g. a Windows file lock) before succeeding', async () => {
    const target = path.join(dir, 'note.md');
    fs.writeFileSync(target, 'original\n');
    const realRename = fsp.rename.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return realRename(from, to);
    });
    await writeFileAtomic(target, 'replacement');
    expect(calls).toBe(2);
    expect(fs.readFileSync(target, 'utf-8')).toBe('replacement');
  });
});

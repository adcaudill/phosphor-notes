import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import {
  recordSnapshot,
  listVersions,
  readVersion,
  VersionNotFoundError,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_AGE_MS
} from '../noteHistory';

describe('noteHistory', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-history-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('stores exact bytes under .phosphor/history and reads them back', async () => {
    const raw = Buffer.from([0x50, 0x48, 0x4f, 0x53, 0x00, 0xff]); // arbitrary, e.g. ciphertext
    const entry = await recordSnapshot(vault, {
      path: 'People/John.md',
      raw,
      tool: 'edit_note',
      summary: '1 edit'
    });
    expect(entry).toMatchObject({ path: 'People/John.md', tool: 'edit_note', size: 6 });
    expect(fs.existsSync(path.join(vault, '.phosphor', 'history', `${entry.id}.snap`))).toBe(true);

    const read = await readVersion(vault, entry.id);
    expect(read.entry).toEqual(entry);
    expect(read.raw.equals(raw)).toBe(true);
  });

  it('lists newest first, filters by path, and limits', async () => {
    const a = await recordSnapshot(vault, { path: 'a.md', raw: Buffer.from('1'), tool: 't' });
    const b = await recordSnapshot(vault, { path: 'b.md', raw: Buffer.from('2'), tool: 't' });
    const c = await recordSnapshot(vault, { path: 'a.md', raw: Buffer.from('3'), tool: 't' });

    expect((await listVersions(vault)).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect((await listVersions(vault, { path: 'a.md' })).map((e) => e.id)).toEqual([c.id, a.id]);
    expect((await listVersions(vault, { limit: 1 })).map((e) => e.id)).toEqual([c.id]);
  });

  it('keeps every entry when snapshots are recorded concurrently', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        recordSnapshot(vault, { path: `n${i}.md`, raw: Buffer.from(String(i)), tool: 't' })
      )
    );
    expect(await listVersions(vault, { limit: 100 })).toHaveLength(10);
  });

  it('rejects unknown and malformed ids (no path traversal through the id)', async () => {
    await expect(readVersion(vault, '1700000000000-deadbeef')).rejects.toBeInstanceOf(
      VersionNotFoundError
    );
    await expect(readVersion(vault, '../../etc/passwd')).rejects.toBeInstanceOf(
      VersionNotFoundError
    );
  });

  it('prunes entries older than the retention window, deleting their snapshot files', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const old = await recordSnapshot(vault, { path: 'x.md', raw: Buffer.from('old'), tool: 't' });

    vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + MAX_HISTORY_AGE_MS + 60_000));
    const fresh = await recordSnapshot(vault, { path: 'x.md', raw: Buffer.from('new'), tool: 't' });

    expect((await listVersions(vault)).map((e) => e.id)).toEqual([fresh.id]);
    expect(fs.existsSync(path.join(vault, '.phosphor', 'history', `${old.id}.snap`))).toBe(false);
  });

  it(`caps history at ${MAX_HISTORY_ENTRIES} entries`, async () => {
    // Seed an index already at the cap, then add one more.
    const dir = path.join(vault, '.phosphor', 'history');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const seeded = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => ({
      id: `${now - 1000 + i}`.padStart(13, '0').slice(-13) + `-${i.toString(16).padStart(8, '0')}`,
      ts: new Date(now).toISOString(),
      path: 'x.md',
      tool: 't',
      size: 1
    }));
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(seeded));

    const added = await recordSnapshot(vault, { path: 'x.md', raw: Buffer.from('n'), tool: 't' });
    const all = await listVersions(vault, { limit: 10_000 });
    expect(all).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(all[0].id).toBe(added.id);
    expect(all.some((e) => e.id === seeded[0].id)).toBe(false);
  });
});

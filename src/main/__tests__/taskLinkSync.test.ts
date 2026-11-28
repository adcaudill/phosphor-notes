import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import { clearTaskIndex, setNoteTaskRefs } from '../taskIndex';
import { syncTaskLinkTitles } from '../taskLinkSync';
import { listVersions } from '../noteHistory';
import { extractTaskRefs } from '../../shared/taskLinks';

describe('syncTaskLinkTitles', () => {
  let vault: string;
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
    setNoteTaskRefs(rel, extractTaskRefs(text));
  };
  const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf-8');

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-tasklinksync-test-'));
    vaultState.setVaultPath(null);
    clearTaskIndex();
  });

  afterEach(() => {
    clearTaskIndex();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('rewrites link titles in linking notes, skipping excluded ones, with history', async () => {
    write('A.md', '- [[_task:k3f9a2xq|Pay rent]]\n');
    write('Daily/2026-11-28.md', '- call about [[_task:k3f9a2xq|Pay rent]] today\n');
    write('Open.md', '- [[_task:k3f9a2xq|Pay rent]]\n');
    write('Other.md', '- [[_task:m8d2c7wa|Unrelated]]\n');

    const changed = await syncTaskLinkTitles(vault, 'k3f9a2xq', 'Pay December rent', {
      expectedGeneration: vaultState.getGeneration(),
      tool: 'test',
      exclude: ['Open.md']
    });

    expect(changed.sort()).toEqual(['A.md', 'Daily/2026-11-28.md']);
    expect(read('A.md')).toBe('- [[_task:k3f9a2xq|Pay December rent]]\n');
    expect(read('Daily/2026-11-28.md')).toBe(
      '- call about [[_task:k3f9a2xq|Pay December rent]] today\n'
    );
    expect(read('Open.md')).toBe('- [[_task:k3f9a2xq|Pay rent]]\n');
    expect(read('Other.md')).toBe('- [[_task:m8d2c7wa|Unrelated]]\n');
    expect(await listVersions(vault, { path: 'A.md' })).toHaveLength(1);
  });

  it('skips notes that disappeared since they were indexed', async () => {
    setNoteTaskRefs('Gone.md', extractTaskRefs('[[_task:k3f9a2xq|x]]'));
    const changed = await syncTaskLinkTitles(vault, 'k3f9a2xq', 'New', {
      expectedGeneration: vaultState.getGeneration(),
      tool: 'test'
    });
    expect(changed).toEqual([]);
  });
});

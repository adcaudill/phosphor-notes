import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as vaultState from '../vaultState';
import { readSavedViews, writeSavedViews } from '../taskSavedViews';
import { loadAllTasks } from '../taskStore';

describe('task saved views', () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-taskviews-test-'));
    vaultState.setVaultPath(null);
  });
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('reads nothing before any are saved', async () => {
    expect(await readSavedViews(vault)).toEqual([]);
  });

  it('saves and reads views, dropping malformed entries', async () => {
    const saved = await writeSavedViews(
      vault,
      [
        { id: 'v1', name: 'Bills this week', query: '#bills due:<7d', group: 'due', sort: 'due' },
        { id: 'v2', name: 'Waiting', query: 'status:waiting' },
        { name: 'no id', query: 'x' },
        'nonsense'
      ],
      vaultState.getGeneration()
    );
    expect(saved).toHaveLength(2);
    expect(await readSavedViews(vault)).toEqual([
      { id: 'v1', name: 'Bills this week', query: '#bills due:<7d', group: 'due', sort: 'due' },
      { id: 'v2', name: 'Waiting', query: 'status:waiting' }
    ]);
  });

  it('is stored where the task loader never sees it', async () => {
    await writeSavedViews(vault, [{ id: 'v', name: 'x', query: 'y' }], vaultState.getGeneration());
    expect(fs.existsSync(path.join(vault, '_tasks', '.views.json'))).toBe(true);
    expect(await loadAllTasks(vault)).toEqual({ tasks: [], problems: [] });
  });
});

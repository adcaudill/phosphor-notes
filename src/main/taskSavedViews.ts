/**
 * Saved views for the Tasks tab (a named search, with its grouping and
 * sorting), stored in the vault - `_tasks/.views.json` - so they travel with
 * it. A dotfile, so the task loader and the file watcher skip it; encrypted
 * when the vault is; written atomically.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';
import { readDecrypted } from './vaultReader';
import { encodeForVault } from './vaultWriter';
import { TASKS_DIR } from '../shared/taskRecord';
import type { SavedTaskView } from '../shared/taskViews';

const FILE = '.views.json';
const MAX_VIEWS = 100;

function viewsPath(vaultPath: string): string {
  return path.join(vaultPath, TASKS_DIR, FILE);
}

function clean(input: unknown): SavedTaskView[] {
  if (!Array.isArray(input)) return [];
  const out: SavedTaskView[] = [];
  for (const v of input) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.query !== 'string')
      continue;
    const view: SavedTaskView = {
      id: r.id,
      name: r.name.slice(0, 100),
      query: r.query.slice(0, 500)
    };
    if (typeof r.group === 'string') view.group = r.group as SavedTaskView['group'];
    if (typeof r.sort === 'string') view.sort = r.sort as SavedTaskView['sort'];
    out.push(view);
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

export async function readSavedViews(vaultPath: string): Promise<SavedTaskView[]> {
  try {
    const text = (await readDecrypted(viewsPath(vaultPath))).toString('utf-8');
    return clean(JSON.parse(text));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

export async function writeSavedViews(
  vaultPath: string,
  views: unknown,
  expectedGeneration: number
): Promise<SavedTaskView[]> {
  const cleaned = clean(views);
  await fsp.mkdir(path.join(vaultPath, TASKS_DIR), { recursive: true });
  const buf = await encodeForVault(
    vaultPath,
    Buffer.from(JSON.stringify(cleaned, null, 2) + '\n', 'utf-8'),
    { expectedGeneration }
  );
  await writeFileAtomic(viewsPath(vaultPath), buf);
  return cleaned;
}

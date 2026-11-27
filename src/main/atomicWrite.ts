import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Errors a rename-over can hit on Windows while another process (antivirus, indexer, sync client) briefly holds the target open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAY_MS = 40;

export interface AtomicWriteOptions {
  /**
   * Fail with EEXIST (like `fs.writeFile(..., { flag: 'wx' })`) instead of
   * replacing an existing file. Implemented with `link()`, which is atomic and
   * never clobbers; falls back to a plain `wx` write on filesystems without
   * hard-link support (that write is still no-clobber, just not atomic).
   */
  exclusive?: boolean;
}

function tempPathFor(absPath: string): string {
  // A dotfile in the same directory: same filesystem (so rename is atomic),
  // and ignored by the vault watcher, listing, and MCP path rules.
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  return path.join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes `data` to `absPath` so that readers (and a crash or power loss
 * mid-write) only ever see the old content or the complete new content,
 * never a truncated file: the bytes go to a temp file in the same directory,
 * are flushed to disk, and are then renamed over the target.
 */
export async function writeFileAtomic(
  absPath: string,
  data: Buffer | string,
  opts: AtomicWriteOptions = {}
): Promise<void> {
  const tmp = tempPathFor(absPath);
  const handle = await fsp.open(tmp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();

  try {
    if (opts.exclusive) {
      try {
        await fsp.link(tmp, absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw err;
        // No hard-link support here (e.g. some network or FAT filesystems):
        // fall back to a no-clobber, non-atomic exclusive write.
        await fsp.writeFile(absPath, data, { flag: 'wx' });
      }
      return;
    }

    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, absPath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_RETRIES) throw err;
        await delay(RENAME_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  } finally {
    // After a successful rename the temp file no longer exists; after a link
    // (or a failure) it still does. Either way, make sure it's gone.
    await fsp.unlink(tmp).catch(() => {});
  }
}

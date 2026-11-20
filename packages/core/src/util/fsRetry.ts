import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

/**
 * Errors that mean "someone else has the file open for a moment". On Windows,
 * antivirus scanners, search indexers and file watchers (Orca's included) hold
 * a just-written file briefly, and a rename over it or a read of it fails with
 * EBUSY, EPERM or EACCES until they let go. Elsewhere EPERM and EACCES are real
 * permission errors, so only EBUSY is retried there.
 */
export function isTransientFsError(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EBUSY') return true;
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}

const DELAYS_MS = [20, 50, 100, 200, 400, 800, 1000];

/** Run `fn`, retrying for about 2.5 s while it fails with a transient file error. */
export async function retryTransient<T>(fn: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= DELAYS_MS.length || !isTransientFsError(err, platform)) throw err;
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  }
}

export function renameRetry(from: string, to: string): Promise<void> {
  return retryTransient(() => fs.rename(from, to));
}

/**
 * Write a file atomically: to a temp file next to it, then renamed over it,
 * so readers never see half a file. The temp name is unique, so two writers
 * can't trip over each other's temp file.
 */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, { encoding: 'utf-8', mode });
  try {
    await renameRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read a text file, or null when it doesn't exist. Other errors (after retrying transient ones) are thrown, not hidden. */
export async function readFileIfExists(file: string): Promise<string | null> {
  try {
    return await retryTransient(() => fs.readFile(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

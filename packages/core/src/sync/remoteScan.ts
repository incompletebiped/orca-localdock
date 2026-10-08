import { LocalDockError, throwIfAborted } from '../errors.js';
import type { RemoteFs, RemoteShell } from '../ssh/types.js';
import type { PathMatcher } from '../util/glob.js';
import { assertSafeRemoteDir } from '../util/remotePath.js';
import { shq } from '../util/shell.js';
import type { BaselineEntry } from './state.js';

export interface RemoteFile {
  size: number;
  mtime: number;
  /** SHA-1 of the content. Undefined until resolved with hashRemoteFiles(). */
  hash?: string;
}

/**
 * Walk the remote docroot over SFTP, collecting size and mtime for every
 * included regular file. Symlinks are skipped.
 */
export async function listRemote(
  sftp: RemoteFs,
  docroot: string,
  matcher: PathMatcher,
  options: { signal?: AbortSignal; onProgress?: (found: number) => void; concurrency?: number } = {},
): Promise<Map<string, RemoteFile>> {
  const root = assertSafeRemoteDir(docroot);
  const files = new Map<string, RemoteFile>();
  const queue: string[] = [''];
  const concurrency = options.concurrency ?? 16;

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      throwIfAborted(options.signal);
      const relDir = queue.shift()!;
      let entries;
      try {
        entries = await sftp.readdir(relDir ? `${root}/${relDir}` : root);
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory) {
          if (!matcher.excludes(rel, true)) queue.push(rel);
        } else if (e.isFile && !matcher.excludes(rel)) {
          files.set(rel, { size: e.size, mtime: e.mtime });
        }
      }
      options.onProgress?.(files.size);
    }
  };

  // Run workers until the queue is drained. Workers exit when the queue is
  // momentarily empty, so loop until nothing is left.
  while (queue.length > 0) {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }
  return files;
}

/** Fill in hashes from the baseline for files whose size and mtime haven't changed. Returns paths still needing a hash. */
export function reuseBaselineHashes(
  files: Map<string, RemoteFile>,
  baseline: Readonly<Record<string, BaselineEntry>>,
): string[] {
  const missing: string[] = [];
  for (const [rel, f] of files) {
    const base = baseline[rel];
    if (base && base.size === f.size && base.remoteMtime === f.mtime) {
      f.hash = base.hash;
    } else {
      missing.push(rel);
    }
  }
  return missing;
}

const HASH_BATCH = 200;

/**
 * Hash remote files with `sha1sum` over SSH, in batches. Each file is read on
 * stdin so file names never need parsing, and every input path produces
 * exactly one output line (`-` when the file is unreadable).
 */
export async function hashRemoteFiles(
  shell: RemoteShell,
  docroot: string,
  relPaths: readonly string[],
  options: { signal?: AbortSignal; onProgress?: (hashed: number) => void } = {},
): Promise<Map<string, string>> {
  const root = assertSafeRemoteDir(docroot);
  const hashes = new Map<string, string>();
  for (let i = 0; i < relPaths.length; i += HASH_BATCH) {
    throwIfAborted(options.signal);
    const batch = relPaths.slice(i, i + HASH_BATCH);
    const script =
      `cd ${shq(root)} || exit 1; for f in ${batch.map(shq).join(' ')}; do ` +
      `h=$(sha1sum < "$f" 2>/dev/null) && echo "\${h%% *}" || echo -; done`;
    const res = await shell.exec(script, { signal: options.signal });
    const lines = res.stdout.split('\n').filter((l) => l.length > 0);
    if (res.code !== 0 || lines.length !== batch.length) {
      throw new LocalDockError(
        `Hashing remote files failed: ${res.stderr.trim() || `expected ${batch.length} hashes, got ${lines.length}`}`,
        'REMOTE_COMMAND_FAILED',
      );
    }
    batch.forEach((rel, j) => {
      const h = lines[j]!.trim();
      // An unreadable file still exists, so it must not look deleted. A unique
      // marker makes it show up as a change that then fails visibly on transfer.
      hashes.set(rel, /^[0-9a-f]{40}$/.test(h) ? h : `unreadable:${rel}`);
    });
    options.onProgress?.(Math.min(i + HASH_BATCH, relPaths.length));
  }
  return hashes;
}

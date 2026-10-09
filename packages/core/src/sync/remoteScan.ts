import { Writable } from 'node:stream';
import { LocalDockError, throwIfAborted } from '../errors.js';
import type { RemoteShell } from '../ssh/types.js';
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
 * List the docroot with a single `find` over SSH: path, size and mtime of every
 * regular file (symlinks are skipped), NUL-separated so any file name survives.
 * One round trip instead of one SFTP readdir per directory. Exclusions are
 * applied here, so they behave exactly like everywhere else.
 */
export async function listRemoteFiles(
  shell: RemoteShell,
  docroot: string,
  matcher: PathMatcher,
  options: { signal?: AbortSignal } = {},
): Promise<Map<string, RemoteFile>> {
  const root = assertSafeRemoteDir(docroot);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk);
      done();
    },
  });
  const res = await shell.exec(`cd ${shq(root)} && find . -type f -printf '%P\\0%s\\0%T@\\0'`, { stdout: sink, signal: options.signal });
  if (res.code !== 0) {
    throw new LocalDockError(`Listing server files failed (exit ${res.code}): ${res.stderr.trim() || 'no output'}`, 'REMOTE_COMMAND_FAILED');
  }
  return parseFileList(Buffer.concat(chunks).toString('utf-8'), matcher);
}

/** Parse `find -printf '%P\0%s\0%T@\0'` output into included files. */
export function parseFileList(output: string, matcher: PathMatcher): Map<string, RemoteFile> {
  const fields = output.split('\0');
  const files = new Map<string, RemoteFile>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const rel = fields[i]!;
    // Names a Windows checkout can't represent the same way (backslashes) are left out.
    if (!rel || rel.includes('\\') || matcher.excludes(rel)) continue;
    // SFTP reports whole seconds; keep the same unit so existing baselines still match.
    files.set(rel, { size: Number(fields[i + 1]), mtime: Math.floor(Number(fields[i + 2])) });
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

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { Parser, type ReadEntry } from 'tar';
import { LocalDockError } from '../errors.js';
import type { RemoteShell } from '../ssh/types.js';
import { assertSafeRemoteDir, localJoin } from '../util/remotePath.js';
import { shq } from '../util/shell.js';
import type { RemoteFile } from './remoteScan.js';
import type { BaselineEntry } from './state.js';

export interface ArchiveDownload {
  /** Baseline entries for every file written. */
  files: Record<string, BaselineEntry>;
  failed: Array<{ path: string; error: string }>;
}

const REGULAR = new Set(['File', 'OldFile', 'ContiguousFile']);
const PROGRESS_EVERY_MS = 250;

/**
 * Download files as one gzipped tar stream over SSH and unpack them as they
 * arrive, instead of one SFTP request (or three) per file. The server archives
 * exactly the listed paths, fed on stdin NUL-separated. Locally, only listed
 * regular files are written, each through localJoin (so nothing lands outside
 * the site folder), and each is hashed while it's written: the content is the
 * server's, so that hash is the baseline for both sides.
 */
export async function downloadArchive(
  shell: RemoteShell,
  docroot: string,
  siteDir: string,
  wanted: ReadonlyMap<string, RemoteFile>,
  options: { signal?: AbortSignal; onProgress?: (bytes: number, totalBytes: number) => void } = {},
): Promise<ArchiveDownload> {
  const root = assertSafeRemoteDir(docroot);
  const result: ArchiveDownload = { files: {}, failed: [] };
  if (wanted.size === 0) return result;

  const pending = new Map(wanted);
  const totalBytes = [...wanted.values()].reduce((sum, f) => sum + f.size, 0);
  let bytes = 0;
  let reportedAt = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - reportedAt < PROGRESS_EVERY_MS) return;
    reportedAt = now;
    options.onProgress?.(bytes, totalBytes);
  };

  const writes: Promise<void>[] = [];
  let current: ReadEntry | undefined;
  const parser = new Parser({ strict: true });
  parser.on('entry', (entry: ReadEntry) => {
    current = entry;
    const rel = entry.path;
    const meta = pending.get(rel);
    if (!meta || !REGULAR.has(entry.type)) {
      entry.resume();
      return;
    }
    pending.delete(rel);
    writes.push(
      writeEntry(entry, siteDir, rel, (n) => {
        bytes += n;
        report();
      }).then(
        async ({ hash, file }) => {
          const st = await fs.stat(file);
          result.files[rel] = { hash, size: st.size, remoteMtime: meta.mtime, localMtimeMs: st.mtimeMs };
        },
        (err: unknown) => {
          result.failed.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        },
      ),
    );
  });
  const parsed = new Promise<void>((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', (err: Error) => reject(new LocalDockError(`The server's file archive was unreadable: ${err.message}`, 'REMOTE_COMMAND_FAILED')));
  });

  // --ignore-failed-read: a file deleted or unreadable since listing is skipped, not fatal (reported below).
  const command = `cd ${shq(root)} && tar -czf - --null --no-recursion --ignore-failed-read -T -`;
  const list = [...wanted.keys()].map((rel) => `${rel}\0`).join('');
  try {
    const res = await shell.exec(command, { stdin: list, stdout: parser as unknown as Writable, signal: options.signal });
    // GNU tar: 0 = fine, 1 = some file changed while it was read (still archived), 2+ = failure.
    if (res.code > 1) {
      throw new LocalDockError(`Archiving server files failed (exit ${res.code}): ${res.stderr.trim() || 'no output'}`, 'REMOTE_COMMAND_FAILED');
    }
    parser.end();
    await parsed;
  } catch (err) {
    // Cancelled or cut off: stop the entry being written so its file is closed, not left waiting for data.
    parsed.catch(() => {});
    current?.destroy();
    throw err;
  } finally {
    // In-flight writes never reject; let them settle so nothing writes after we return.
    await Promise.all(writes);
  }
  report(true);
  for (const rel of pending.keys()) result.failed.push({ path: rel, error: 'Not in the server archive (deleted or unreadable since listing)' });
  return result;
}

/** Stream one archive entry to its file via a temp name, hashing on the way. Always consumes the entry. */
async function writeEntry(entry: ReadEntry, siteDir: string, rel: string, onBytes: (n: number) => void): Promise<{ hash: string; file: string }> {
  let file: string;
  try {
    file = localJoin(siteDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
  } catch (err) {
    entry.resume();
    throw err;
  }
  const tmp = `${file}.localdock-part`;
  const out = createWriteStream(tmp);
  let writeError: Error | undefined;
  out.on('error', (err) => (writeError ??= err));
  const hash = createHash('sha1');
  let complete = false;
  try {
    for await (const chunk of entry as AsyncIterable<Buffer>) {
      hash.update(chunk);
      onBytes(chunk.length);
      // After a write error keep reading, so the archive stream moves on to the next file.
      if (!writeError && !out.write(chunk)) await Promise.race([once(out, 'drain'), once(out, 'error')]).catch(() => {});
    }
    complete = !entry.destroyed;
  } finally {
    out.end();
    await once(out, 'close').catch(() => {});
    if (writeError || !complete) await fs.rm(tmp, { force: true });
  }
  if (writeError) throw writeError;
  if (!complete) throw new LocalDockError('Download stopped part-way', 'CANCELLED');
  await fs.rename(tmp, file);
  return { hash: hash.digest('hex'), file };
}

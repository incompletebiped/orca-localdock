import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { throwIfAborted } from '../errors.js';
import type { PathMatcher } from '../util/glob.js';
import { mapLimit } from '../util/concurrency.js';
import type { BaselineEntry } from './state.js';

export interface LocalFile {
  hash: string;
  size: number;
  mtimeMs: number;
}

export function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    createReadStream(file)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Walk the local site folder and hash every included file. Files whose size
 * and mtime match the baseline reuse the baseline hash instead of being read.
 * Symlinks are skipped.
 */
export async function scanLocal(
  siteDir: string,
  matcher: PathMatcher,
  baseline: Readonly<Record<string, BaselineEntry>>,
  options: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {},
): Promise<Map<string, LocalFile>> {
  const found: Array<{ rel: string; size: number; mtimeMs: number }> = [];

  const walk = async (dir: string, relDir: string): Promise<void> => {
    throwIfAborted(options.signal);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!matcher.excludes(rel, true)) {
          await walk(path.join(dir, e.name), rel);
        }
      } else if (e.isFile() && !matcher.excludes(rel)) {
        const st = await fs.stat(path.join(dir, e.name));
        found.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  await walk(siteDir, '');

  const result = new Map<string, LocalFile>();
  let done = 0;
  await mapLimit(
    found,
    16,
    async (f) => {
      const base = baseline[f.rel];
      const hash =
        base && base.size === f.size && base.localMtimeMs === f.mtimeMs
          ? base.hash
          : await sha1File(path.join(siteDir, ...f.rel.split('/')));
      result.set(f.rel, { hash, size: f.size, mtimeMs: f.mtimeMs });
      options.onProgress?.(++done);
    },
    options.signal,
  );
  return result;
}

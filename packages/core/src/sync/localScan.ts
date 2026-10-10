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
  const result = new Map<string, LocalFile>();
  await updateLocal(siteDir, matcher, baseline, await listFiles(siteDir, '', matcher, options.signal), result, options);
  return result;
}

/** Included files under a folder of the site (site-relative paths), walking subfolders in parallel. */
async function listFiles(siteDir: string, relDir: string, matcher: PathMatcher, signal?: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    throwIfAborted(signal);
    let entries;
    try {
      entries = await fs.readdir(path.join(siteDir, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: Array<Promise<void>> = [];
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!matcher.excludes(child, true)) subdirs.push(walk(child));
      } else if (e.isFile() && !matcher.excludes(child)) {
        found.push(child);
      }
    }
    await Promise.all(subdirs);
  };
  await walk(relDir);
  return found;
}

/**
 * Re-check some paths of an earlier scan (files or folders that changed),
 * updating `local` in place: changed files are re-hashed, removed ones dropped.
 */
export async function updateLocal(
  siteDir: string,
  matcher: PathMatcher,
  baseline: Readonly<Record<string, BaselineEntry>>,
  paths: readonly string[],
  local: Map<string, LocalFile>,
  options: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {},
): Promise<void> {
  let done = 0;
  const more: string[] = [];
  await mapLimit(
    [...new Set(paths)],
    32,
    async (rel) => {
      const abs = path.join(siteDir, ...rel.split('/'));
      const st = await fs.lstat(abs).catch(() => null);
      if (st?.isDirectory()) {
        // A folder appeared or was renamed: check everything under it, and anything it used to hold.
        if (!matcher.excludes(rel, true)) {
          for (const k of local.keys()) if (k.startsWith(`${rel}/`)) more.push(k);
          more.push(...(await listFiles(siteDir, rel, matcher, options.signal)));
        }
        return;
      }
      if (!st?.isFile() || matcher.excludes(rel)) {
        local.delete(rel);
        for (const k of local.keys()) if (k.startsWith(`${rel}/`)) more.push(k); // a removed folder
        return;
      }
      const base = baseline[rel];
      const prev = local.get(rel);
      const hash =
        base && base.size === st.size && base.localMtimeMs === st.mtimeMs ? base.hash
        : prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.hash
        : await sha1File(abs);
      local.set(rel, { hash, size: st.size, mtimeMs: st.mtimeMs });
      options.onProgress?.(++done);
    },
    options.signal,
  );
  if (more.length > 0) await updateLocal(siteDir, matcher, baseline, more, local, options);
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { readFileIfExists, writeFileAtomic } from '../util/fsRetry.js';
import { localJoin } from '../util/remotePath.js';
import type { RemoteFile } from './remoteScan.js';
import { LOCALDOCK_DIR, baselineEntrySchema, type BaselineEntry } from './state.js';

/**
 * The files a pull has finished so far, so an interrupted pull (a dropped
 * connection, a cancel, a restarted worker) can pick up where it stopped.
 * Kept in `.localdock/pull.json` until the pull completes. It says nothing
 * about which server or folder to pull from: that comes from the plugin's own
 * storage, since the project folder isn't trusted.
 */
const pullProgressSchema = z.object({
  version: z.literal(1),
  domain: z.string(),
  startedAt: z.string(),
  files: z.record(z.string(), baselineEntrySchema),
});
export type PullProgress = z.infer<typeof pullProgressSchema>;

const PROGRESS_FILE = 'pull.json';
/** The temporary name a download is written under until it's complete (see remoteArchive). */
export const PART_SUFFIX = '.localdock-part';

export function pullProgressPath(siteDir: string): string {
  return path.join(siteDir, LOCALDOCK_DIR, PROGRESS_FILE);
}

/** The unfinished pull in this folder, or null. A record that can't be read counts as none (its files are re-downloaded). */
export async function readPullProgress(siteDir: string): Promise<PullProgress | null> {
  const raw = await readFileIfExists(pullProgressPath(siteDir));
  if (raw === null) return null;
  try {
    return pullProgressSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writePullProgress(siteDir: string, progress: PullProgress): Promise<void> {
  await fs.mkdir(path.join(siteDir, LOCALDOCK_DIR), { recursive: true });
  await writeFileAtomic(pullProgressPath(siteDir), JSON.stringify(progress));
}

export async function clearPullProgress(siteDir: string): Promise<void> {
  await fs.rm(pullProgressPath(siteDir), { force: true });
}

/**
 * Split a resumed pull's files into those already done and those still to
 * download. A file counts as done only if the server still reports the size
 * and mtime it had when it was downloaded, and the local copy is untouched
 * since (same size and mtime).
 */
export async function filesLeftToPull(
  siteDir: string,
  remote: ReadonlyMap<string, RemoteFile>,
  done: Readonly<Record<string, BaselineEntry>>,
): Promise<{ kept: Record<string, BaselineEntry>; left: Map<string, RemoteFile> }> {
  const kept: Record<string, BaselineEntry> = {};
  const left = new Map<string, RemoteFile>();
  for (const [rel, meta] of remote) {
    const entry = done[rel];
    if (entry && entry.size === meta.size && entry.remoteMtime === meta.mtime && (await unchangedLocally(siteDir, rel, entry))) {
      kept[rel] = entry;
    } else {
      left.set(rel, meta);
    }
  }
  return { kept, left };
}

/** Delete half-written downloads (`*.localdock-part`) a stopped worker left behind. */
export async function removePartialDownloads(siteDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(siteDir, { recursive: true });
  } catch {
    return;
  }
  for (const rel of entries) {
    if (rel.endsWith(PART_SUFFIX)) await fs.rm(path.join(siteDir, rel), { force: true });
  }
}

async function unchangedLocally(siteDir: string, rel: string, entry: BaselineEntry): Promise<boolean> {
  try {
    const st = await fs.lstat(localJoin(siteDir, rel));
    return st.isFile() && st.size === entry.size && st.mtimeMs === entry.localMtimeMs;
  } catch {
    return false;
  }
}

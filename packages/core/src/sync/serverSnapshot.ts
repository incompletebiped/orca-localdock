import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { HashMap } from './changeSet.js';
import { LOCALDOCK_DIR, type BaselineEntry } from './state.js';

/**
 * What the server looked like at the last check, kept as its differences
 * from the baseline: path → content hash, or null for a file that's gone on
 * the server. With it, local changes can be compared against the server's
 * last known state at any time without connecting.
 */
export const serverSnapshotSchema = z.object({
  checkedAt: z.string(),
  changed: z.record(z.string(), z.string().nullable()),
});
export type ServerSnapshot = z.infer<typeof serverSnapshotSchema>;

const SNAPSHOT_FILE = 'server.json';

function snapshotPath(siteDir: string): string {
  return path.join(siteDir, LOCALDOCK_DIR, SNAPSHOT_FILE);
}

export async function readServerSnapshot(siteDir: string): Promise<ServerSnapshot | null> {
  try {
    return serverSnapshotSchema.parse(JSON.parse(await fs.readFile(snapshotPath(siteDir), 'utf-8')));
  } catch {
    return null;
  }
}

export async function writeServerSnapshot(siteDir: string, snapshot: ServerSnapshot): Promise<void> {
  const file = snapshotPath(siteDir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, file);
}

/** The server's differences from the baseline, from a full server listing (path → hash). */
export function serverDifferences(baseline: Readonly<Record<string, BaselineEntry>>, remote: HashMap): Record<string, string | null> {
  const changed: Record<string, string | null> = {};
  for (const [p, hash] of remote) if (baseline[p]?.hash !== hash) changed[p] = hash;
  for (const p of Object.keys(baseline)) if (!remote.has(p)) changed[p] = null;
  return changed;
}

/** The server's last known content: the baseline, with the snapshot's differences applied. */
export function serverHashes(baseline: Readonly<Record<string, BaselineEntry>>, snapshot: ServerSnapshot | null): Map<string, string> {
  const hashes = new Map(Object.entries(baseline).map(([p, e]) => [p, e.hash]));
  for (const [p, hash] of Object.entries(snapshot?.changed ?? {})) {
    if (hash === null) hashes.delete(p);
    else hashes.set(p, hash);
  }
  return hashes;
}

/** After a push or pull, these paths match the server again (their baseline was just updated or removed). */
export async function forgetServerDifferences(siteDir: string, paths: readonly string[]): Promise<void> {
  const snapshot = await readServerSnapshot(siteDir);
  if (!snapshot || paths.length === 0) return;
  for (const p of paths) delete snapshot.changed[p];
  await writeServerSnapshot(siteDir, snapshot);
}

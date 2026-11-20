import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { readFileIfExists, writeFileAtomic } from '../util/fsRetry.js';

/**
 * What a file looked like the last time local and live were in sync for it
 * (after a pull or push). Change detection compares both sides against this.
 */
export const baselineEntrySchema = z.object({
  /** SHA-1 of the content, identical on both sides at sync time. */
  hash: z.string(),
  size: z.number(),
  /** Remote mtime (seconds) as reported by SFTP after the transfer. */
  remoteMtime: z.number(),
  /** Local mtime (ms) after the transfer. Used to skip re-hashing unchanged local files. */
  localMtimeMs: z.number(),
});
export type BaselineEntry = z.infer<typeof baselineEntrySchema>;

export const siteStateSchema = z.object({
  version: z.literal(1),
  /** Orca SSH host the site was pulled from. */
  hostId: z.string(),
  /** cPanel account that owns the site (used to chown files when connected as root). */
  account: z.string(),
  domain: z.string(),
  docroot: z.string(),
  productionUrl: z.string(),
  tablePrefix: z.string().default('wp_'),
  pulledAt: z.string(),
  lastPushedAt: z.string().optional(),
  /** DDEV's local URL the last time the database was rewritten for it. */
  localUrl: z.string().optional(),
  files: z.record(z.string(), baselineEntrySchema),
});
export type SiteState = z.infer<typeof siteStateSchema>;

export const LOCALDOCK_DIR = '.localdock';
const STATE_FILE = 'state.json';

export function statePath(siteDir: string): string {
  return path.join(siteDir, LOCALDOCK_DIR, STATE_FILE);
}

/** The site's sync state, or null when the folder has none. A file that's there but can't be read is an error, not "no site". */
export async function readSiteState(siteDir: string): Promise<SiteState | null> {
  const raw = await readFileIfExists(statePath(siteDir));
  return raw === null ? null : siteStateSchema.parse(JSON.parse(raw));
}

/** Write atomically so an interrupted write never leaves a half-written state file. */
export async function writeSiteState(siteDir: string, state: SiteState): Promise<void> {
  const file = statePath(siteDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(state, null, 2));
}

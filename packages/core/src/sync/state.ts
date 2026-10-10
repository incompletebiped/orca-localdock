import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

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

export async function readSiteState(siteDir: string): Promise<SiteState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath(siteDir), 'utf-8');
  } catch {
    return null;
  }
  return siteStateSchema.parse(JSON.parse(raw));
}

/** Write atomically so an interrupted write never leaves a half-written state file. */
export async function writeSiteState(siteDir: string, state: SiteState): Promise<void> {
  const file = statePath(siteDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, file);
}

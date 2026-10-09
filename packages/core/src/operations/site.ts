import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalDockError } from '../errors.js';
import {
  backupRemoteDatabase,
  dumpRemoteDatabase,
  importRemoteDatabase,
  readRemoteDbCredentials,
  restoreRemoteBackup,
  searchReplaceRemote,
  withOptionFile,
  type DbCredentials,
  type RemoteBackup,
} from '../db/remoteDb.js';
import { urlReplacePairs } from '../db/searchReplace.js';
import { groupTables, type TableGroup } from '../db/tableGroups.js';
import type { Ddev, DdevDescription } from '../ddev/Ddev.js';
import { DEV_MU_PLUGIN, localWpConfig, sanitizeHtaccess, uploadsProxyHtaccess } from '../ddev/templates.js';
import type { DiscoveredSite } from '../discovery/discover.js';
import { excludePatterns, type ExcludeOptions } from '../sync/excludes.js';
import { listRemoteFiles } from '../sync/remoteScan.js';
import { LOCALDOCK_DIR, readSiteState, writeSiteState, type SiteState } from '../sync/state.js';
import { formatBytes, type ByteProgress } from '../util/format.js';
import { PathMatcher } from '../util/glob.js';
import { assertSafeRemoteDir } from '../util/remotePath.js';
import { shq } from '../util/shell.js';
import type { OperationContext, TransferFailure } from './context.js';
import { downloadFiles, requireState } from './fileSync.js';

/** Entries a freshly created Orca project may already contain. Anything else means the folder isn't empty. */
/** What a brand-new project may already hold. It still counts as empty, and a reset keeps these. */
export const PROJECT_SCAFFOLD_ENTRIES: ReadonlySet<string> = new Set(['.git', '.orca', '.gitignore', '.gitattributes', '.DS_Store', 'Thumbs.db', '.vscode', '.idea']);
// LOCALDOCK_DIR too: a cancelled pull can leave it behind, and it never holds the user's own files.
const IGNORABLE_PROJECT_ENTRIES = new Set([LOCALDOCK_DIR, ...PROJECT_SCAFFOLD_ENTRIES]);

export async function isEmptyProject(projectDir: string): Promise<boolean> {
  try {
    return (await fs.readdir(projectDir)).every((e) => IGNORABLE_PROJECT_ENTRIES.has(e));
  } catch {
    return true;
  }
}

/** Read the site's `home` URL from its database, falling back to https://domain. */
export async function readProductionUrl(ctx: OperationContext, creds: DbCredentials, domain: string): Promise<string> {
  try {
    const url = await withOptionFile(ctx.shell, ctx.sftp, creds, async (cnf) => {
      const sql = `SELECT option_value FROM \`${creds.tablePrefix}options\` WHERE option_name = 'home' LIMIT 1`;
      const res = await ctx.shell.exec(['mysql', `--defaults-extra-file=${cnf}`, '-N', '-B', '-e', sql, creds.name].map(shq).join(' '));
      return res.code === 0 ? res.stdout.trim() : '';
    });
    if (/^https?:\/\/[^\s'"]+$/.test(url)) return url.replace(/\/$/, '');
  } catch (err) {
    ctx.logger.warn(`Couldn't read the home URL: ${(err as Error).message}`);
  }
  return `https://${domain}`;
}

/** PHP `major.minor` and database engine on the server, so DDEV can match them. */
export async function detectServerVersions(ctx: OperationContext): Promise<{ php?: string; database?: string }> {
  const out: { php?: string; database?: string } = {};
  const php = await ctx.shell.exec(`php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null`);
  if (php.code === 0 && /^\d+\.\d+$/.test(php.stdout.trim())) out.php = php.stdout.trim();
  const db = await ctx.shell.exec('mysql --version 2>/dev/null');
  const maria = db.stdout.match(/(\d+\.\d+)\.\d+-MariaDB/i);
  const mysql = db.stdout.match(/(?:Ver|Distrib)\s+(\d+\.\d+)/i);
  if (maria) out.database = `mariadb:${maria[1]}`;
  else if (mysql) out.database = `mysql:${mysql[1]}`;
  return out;
}

export interface PullSiteOptions {
  hostId: string;
  site: DiscoveredSite;
  projectDir: string;
  exclude?: ExcludeOptions;
  /** Start DDEV and import the database after downloading. */
  start: boolean;
}

export interface PullSiteResult {
  state: SiteState;
  failed: TransferFailure[];
  fileCount: number;
}

/**
 * Pull a site into an empty project: files over SFTP, the database dump, the
 * sync baseline, a local wp-config.php, and the DDEV project.
 */
export async function pullSite(ctx: OperationContext, opts: PullSiteOptions): Promise<PullSiteResult> {
  const docroot = assertSafeRemoteDir(opts.site.docroot);
  if (await readSiteState(opts.projectDir)) {
    throw new LocalDockError('This project already holds a LocalDock site.', 'CONFLICT_DETECTED', false);
  }
  if (!(await isEmptyProject(opts.projectDir))) {
    throw new LocalDockError('Pull into an empty project. This one already has files in it.', 'CONFLICT_DETECTED', false);
  }
  await fs.mkdir(path.join(opts.projectDir, LOCALDOCK_DIR), { recursive: true });

  ctx.progress({ phase: 'database', message: 'Reading the site configuration…' });
  const creds = await readRemoteDbCredentials(ctx.sftp, docroot);
  const productionUrl = await readProductionUrl(ctx, creds, opts.site.domain);

  ctx.progress({ phase: 'files', message: 'Listing server files…' });
  const matcher = new PathMatcher(excludePatterns(opts.exclude));
  const remote = await listRemoteFiles(ctx.shell, docroot, matcher, { signal: ctx.signal });

  const state: SiteState = {
    version: 1,
    hostId: opts.hostId,
    account: opts.site.account,
    domain: opts.site.domain,
    docroot,
    productionUrl,
    tablePrefix: creds.tablePrefix,
    pulledAt: new Date().toISOString(),
    files: {},
  };

  const { files, failed } = await downloadFiles(ctx, opts.projectDir, docroot, remote);
  state.files = files;

  // The root .htaccess isn't synced (it's environment-specific) but the site needs its rewrite rules locally.
  try {
    await ctx.sftp.download(`${docroot}/.htaccess`, path.join(opts.projectDir, '.htaccess'));
  } catch {
    // Optional.
  }

  ctx.progress({ phase: 'database', message: 'Downloading the database…' });
  await dumpRemoteDatabase(ctx.shell, ctx.sftp, creds, dumpPath(opts.projectDir), { signal: ctx.signal, onProgress: dbProgress(ctx, 'Downloading the database', true) });
  await writeSiteState(opts.projectDir, state);
  await writeLocalFiles(opts.projectDir, state);

  ctx.progress({ phase: 'ddev', message: 'Configuring DDEV…' });
  const versions = await detectServerVersions(ctx).catch(() => ({}) as { php?: string; database?: string });
  await ctx.ddev.configure(opts.projectDir, { projectName: opts.site.domain, phpVersion: versions.php, database: versions.database });

  if (opts.start) {
    await startSite(ctx, opts.projectDir, { importDump: true });
  }
  return { state: (await readSiteState(opts.projectDir))!, failed, fileCount: remote.size };
}

/**
 * Progress for a database transfer, e.g. "Downloading the database… 21 MB of about 60 MB (85 KB/s)".
 * A dump's total is an estimate, so the bar stops short of full until the next step starts.
 */
function dbProgress(ctx: OperationContext, verb: string, estimated: boolean): ByteProgress {
  const started = Date.now();
  return (bytes, total) => {
    const seconds = (Date.now() - started) / 1000;
    const rate = seconds >= 1 ? ` (${formatBytes(bytes / seconds)}/s)` : '';
    const of = total ? ` of ${estimated ? 'about ' : ''}${formatBytes(total)}` : '';
    // An import has sent everything once bytes reach the total; the database is still loading it.
    const message = !estimated && total !== undefined && bytes >= total ? `${verb}… almost done` : `${verb}… ${formatBytes(bytes)}${of}${rate}`;
    ctx.progress({ phase: 'database', message, ...(total ? { current: Math.min(bytes, Math.floor(total * 0.99)), total } : {}) });
  };
}

export function dumpPath(projectDir: string): string {
  return path.join(projectDir, LOCALDOCK_DIR, 'db.sql');
}

/** Files that exist only locally: wp-config.php, the dev mu-plugin, the uploads proxy, a sanitized .htaccess. */
async function writeLocalFiles(projectDir: string, state: SiteState): Promise<void> {
  await fs.writeFile(path.join(projectDir, 'wp-config.php'), localWpConfig(state.tablePrefix), { mode: 0o600 });
  const mu = path.join(projectDir, 'wp-content', 'mu-plugins');
  await fs.mkdir(mu, { recursive: true });
  await fs.writeFile(path.join(mu, 'localdock-dev.php'), DEV_MU_PLUGIN);
  const uploads = path.join(projectDir, 'wp-content', 'uploads');
  await fs.mkdir(uploads, { recursive: true });
  await fs.writeFile(path.join(uploads, '.htaccess'), uploadsProxyHtaccess(state.productionUrl));
  const htaccess = path.join(projectDir, '.htaccess');
  try {
    const content = await fs.readFile(htaccess, 'utf-8');
    const clean = sanitizeHtaccess(content);
    if (clean !== content) await fs.writeFile(htaccess, clean);
  } catch {
    // No .htaccess.
  }
}

/**
 * Start DDEV. With `importDump`, load `.localdock/db.sql` and rewrite the
 * production URL to DDEV's local URL.
 */
export async function startSite(ctx: OperationContext, projectDir: string, opts: { importDump?: boolean } = {}): Promise<DdevDescription> {
  const state = await requireState(projectDir);
  ctx.progress({ phase: 'ddev', message: 'Starting DDEV…' });
  await ctx.ddev.start(projectDir, ctx.signal);
  const info = await ctx.ddev.describe(projectDir);
  if (!info.url) throw new LocalDockError('DDEV started but reported no site URL', 'DOCKER_START_FAILED');

  const importDump = opts.importDump ?? state.localUrl === undefined;
  if (importDump) {
    ctx.progress({ phase: 'database', message: 'Importing the database…' });
    await ctx.ddev.importDb(projectDir, dumpPath(projectDir), dbProgress(ctx, 'Importing the database', false));
  }
  const from = importDump ? state.productionUrl : state.localUrl;
  if (from && from !== info.url) {
    ctx.progress({ phase: 'database', message: 'Rewriting URLs for the local site…' });
    await ctx.ddev.searchReplace(projectDir, urlReplacePairs(from, info.url));
  }
  state.localUrl = info.url;
  await writeSiteState(projectDir, state);
  return info;
}

export async function stopSite(ctx: OperationContext, projectDir: string): Promise<void> {
  ctx.progress({ phase: 'ddev', message: 'Stopping DDEV…' });
  await ctx.ddev.stop(projectDir);
}

/** Tables in the local database, grouped for the push dialog. */
export async function localTableGroups(ddev: Ddev, projectDir: string): Promise<Record<TableGroup, string[]>> {
  const state = await requireState(projectDir);
  return groupTables(await ddev.listTables(projectDir), state.tablePrefix);
}

export interface PushDatabaseResult {
  backup: RemoteBackup;
  tables: string[];
  rewritten: number;
}

/**
 * Push the selected table groups to the live database:
 * 1. dump those tables from the local DDEV database,
 * 2. back up the entire live database on the server,
 * 3. import the dump over SSH,
 * 4. rewrite the local URL back to the production URL in the pushed tables.
 * If importing or rewriting fails, the backup is restored automatically.
 */
export async function pushDatabase(ctx: OperationContext, projectDir: string, groups: readonly TableGroup[]): Promise<PushDatabaseResult> {
  if (groups.length === 0) throw new LocalDockError('Choose at least one group of tables to push', 'UNSAFE_INPUT', false);
  const state = await requireState(projectDir);
  if (!state.localUrl) throw new LocalDockError('Start the site locally before pushing its database', 'NOT_FOUND', false);

  const creds = await readRemoteDbCredentials(ctx.sftp, state.docroot);
  if (creds.tablePrefix !== state.tablePrefix) {
    throw new LocalDockError(
      `The live table prefix (${creds.tablePrefix}) differs from the pulled one (${state.tablePrefix}).`,
      'CONFLICT_DETECTED',
      false,
    );
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'localdock-push-'));
  const file = path.join(tmp, 'push.sql');
  try {
    const byGroup = groupTables(await ctx.ddev.listTables(projectDir), state.tablePrefix);
    const tables = groups.flatMap((g) => byGroup[g]);
    if (tables.length === 0) throw new LocalDockError('No tables in the selected groups', 'NOT_FOUND', false);

    ctx.progress({ phase: 'database', message: `Exporting ${tables.length} local table(s)…` });
    await ctx.ddev.exportTables(projectDir, file, tables);

    ctx.progress({ phase: 'database', message: 'Backing up the live database…' });
    const backup = await backupRemoteDatabase(ctx.shell, ctx.sftp, creds, { signal: ctx.signal });

    try {
      ctx.progress({ phase: 'database', message: 'Importing into the live database…' });
      await importRemoteDatabase(ctx.shell, ctx.sftp, creds, file, { signal: ctx.signal });
      ctx.progress({ phase: 'database', message: 'Rewriting URLs for production…' });
      const rewritten = await searchReplaceRemote(ctx.shell, creds, tables, urlReplacePairs(state.localUrl, state.productionUrl));
      return { backup, tables, rewritten };
    } catch (err) {
      ctx.logger.error(`Database push failed; restoring ${backup.path}`);
      await restoreRemoteBackup(ctx.shell, ctx.sftp, creds, backup.path).catch((e) =>
        ctx.logger.error(`Automatic restore failed: ${(e as Error).message}. Restore manually from ${backup.path}`),
      );
      throw err;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function rollbackDatabase(ctx: OperationContext, projectDir: string, backupPath: string): Promise<void> {
  const state = await requireState(projectDir);
  const creds = await readRemoteDbCredentials(ctx.sftp, state.docroot);
  ctx.progress({ phase: 'database', message: 'Restoring the live database…' });
  await restoreRemoteBackup(ctx.shell, ctx.sftp, creds, backupPath);
}

/** Replace the local database with a fresh copy of the live one. */
export async function pullDatabase(ctx: OperationContext, projectDir: string): Promise<void> {
  const state = await requireState(projectDir);
  const creds = await readRemoteDbCredentials(ctx.sftp, state.docroot);
  ctx.progress({ phase: 'database', message: 'Downloading the live database…' });
  await dumpRemoteDatabase(ctx.shell, ctx.sftp, creds, dumpPath(projectDir), { signal: ctx.signal, onProgress: dbProgress(ctx, 'Downloading the live database', true) });
  await startSite(ctx, projectDir, { importDump: true });
}

/** Backups taken before database pushes, newest first. */
export async function listBackups(ctx: OperationContext): Promise<string[]> {
  const home = assertSafeRemoteDir(await ctx.sftp.realpath('.'));
  try {
    return (await ctx.sftp.readdir(`${home}/.localdock-backups`))
      .filter((e) => e.isFile && e.name.endsWith('.sql.gz'))
      .map((e) => `${home}/.localdock-backups/${e.name}`)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

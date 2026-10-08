import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LocalDockError } from '../errors.js';
import { computeChangeSet, type ChangeEntry } from '../sync/changeSet.js';
import { excludePatterns, type ExcludeOptions } from '../sync/excludes.js';
import { scanLocal, sha1File } from '../sync/localScan.js';
import { hashRemoteFiles, listRemote, reuseBaselineHashes } from '../sync/remoteScan.js';
import { readSiteState, writeSiteState, type BaselineEntry, type SiteState } from '../sync/state.js';
import { mapLimit } from '../util/concurrency.js';
import { PathMatcher } from '../util/glob.js';
import { localJoin, normalizeRelPath, remoteDirname, remoteJoin, assertSafeRemoteDir } from '../util/remotePath.js';
import { assertValid, isValidCpanelUser, shq } from '../util/shell.js';
import type { OperationContext, TransferFailure } from './context.js';

export interface SiteChanges {
  state: SiteState;
  entries: ChangeEntry[];
  local: Map<string, { hash: string; size: number; mtimeMs: number }>;
  remote: Map<string, { size: number; mtime: number; hash?: string }>;
}

export async function requireState(siteDir: string): Promise<SiteState> {
  const state = await readSiteState(siteDir);
  if (!state) throw new LocalDockError(`${siteDir} isn't a LocalDock site (no .localdock/state.json)`, 'NOT_FOUND', false);
  return state;
}

/**
 * Compare local and live against the sync baseline. Only files whose stat
 * changed get hashed: local files are read, remote files are hashed with
 * sha1sum over SSH.
 */
export async function computeSiteChanges(
  ctx: OperationContext,
  siteDir: string,
  exclude: ExcludeOptions = {},
): Promise<SiteChanges> {
  const state = await requireState(siteDir);
  const matcher = new PathMatcher(excludePatterns(exclude));

  ctx.progress({ phase: 'scan', message: 'Scanning local files…' });
  const local = await scanLocal(siteDir, matcher, state.files, { signal: ctx.signal });

  ctx.progress({ phase: 'scan', message: 'Scanning server files…' });
  const remote = await listRemote(ctx.sftp, state.docroot, matcher, {
    signal: ctx.signal,
    onProgress: (n) => ctx.progress({ phase: 'scan', message: `Scanning server files… (${n})` }),
  });
  const toHash = reuseBaselineHashes(remote, state.files);
  if (toHash.length > 0) {
    ctx.progress({ phase: 'scan', message: `Checking ${toHash.length} changed server file(s)…`, current: 0, total: toHash.length });
    const hashes = await hashRemoteFiles(ctx.shell, state.docroot, toHash, {
      signal: ctx.signal,
      onProgress: (n) => ctx.progress({ phase: 'scan', message: 'Checking changed server files…', current: n, total: toHash.length }),
    });
    for (const [rel, h] of hashes) remote.get(rel)!.hash = h;
  }

  const entries = computeChangeSet(
    new Map(Object.entries(state.files).map(([p, e]) => [p, e.hash])),
    new Map([...local].map(([p, f]) => [p, f.hash])),
    new Map([...remote].filter(([, f]) => f.hash !== undefined).map(([p, f]) => [p, f.hash!])),
  );
  return { state, entries, local, remote };
}

function selectEntries(
  changes: SiteChanges,
  paths: readonly string[],
  direction: 'push' | 'pull',
  allowConflicts: boolean,
): ChangeEntry[] {
  const wanted = new Set(paths.map(normalizeRelPath));
  const selected = changes.entries.filter((e) => wanted.has(e.path));
  const bad = selected.filter((e) => e.direction === 'conflict' && !allowConflicts);
  if (bad.length > 0) {
    throw new LocalDockError(
      `${bad.length} file(s) changed on both sides: ${bad.slice(0, 5).map((e) => e.path).join(', ')}` +
        (bad.length > 5 ? '…' : '') + '. Review them and choose which version to keep.',
      'CONFLICT_DETECTED',
    );
  }
  return selected.filter((e) => e.direction === direction || e.direction === 'conflict' || e.direction === 'same');
}

export interface SyncResult {
  transferred: string[];
  deleted: string[];
  failed: TransferFailure[];
}

/**
 * Upload the selected local changes to the server and delete files removed
 * locally. The change set is recomputed first, so a file that changed on the
 * server since the user last looked is caught as a conflict.
 */
export async function pushFiles(
  ctx: OperationContext,
  siteDir: string,
  paths: readonly string[],
  options: { allowConflicts?: boolean; exclude?: ExcludeOptions; account?: string } = {},
): Promise<SyncResult> {
  const changes = await computeSiteChanges(ctx, siteDir, options.exclude);
  const { state } = changes;
  const docroot = assertSafeRemoteDir(state.docroot);
  const selected = selectEntries(changes, paths, 'push', options.allowConflicts ?? false);
  const uploads = selected.filter((e) => e.local === 'added' || e.local === 'modified');
  const deletes = selected.filter((e) => e.local === 'deleted');
  const result: SyncResult = { transferred: [], deleted: [], failed: [] };
  const total = uploads.length + deletes.length;
  let done = 0;
  const tick = (verb: string) => ctx.progress({ phase: 'files', message: `${verb}… (${++done}/${total})`, current: done, total });

  const madeDirs = new Set<string>();
  try {
    // Create parent directories one at a time, so concurrent uploads don't race on mkdir.
    for (const dir of new Set(uploads.map((e) => remoteDirname(remoteJoin(docroot, e.path))))) {
      await ctx.sftp.mkdirp(dir);
      madeDirs.add(dir);
    }

    const up = await mapLimit(
      uploads,
      ctx.concurrency,
      async (e) => {
        const localFile = localJoin(siteDir, e.path);
        const remoteFile = remoteJoin(docroot, e.path);
        await ctx.sftp.upload(localFile, remoteFile);
        const [rst, lst] = await Promise.all([ctx.sftp.stat(remoteFile), fs.stat(localFile)]);
        state.files[e.path] = {
          hash: changes.local.get(e.path)?.hash ?? (await sha1File(localFile)),
          size: lst.size,
          remoteMtime: rst.mtime,
          localMtimeMs: lst.mtimeMs,
        };
        result.transferred.push(e.path);
        tick('Uploading');
      },
      ctx.signal,
    );
    const del = await mapLimit(
      deletes,
      ctx.concurrency,
      async (e) => {
        await ctx.sftp.unlink(remoteJoin(docroot, e.path));
        delete state.files[e.path];
        result.deleted.push(e.path);
        tick('Deleting');
      },
      ctx.signal,
    );
    for (const r of [...up, ...del]) {
      if (!r.ok) result.failed.push({ path: r.item.path, error: (r.error as Error).message ?? String(r.error) });
    }

    if (ctx.asRoot && result.transferred.length > 0) {
      const account = assertValid('cPanel account', options.account ?? state.account, isValidCpanelUser);
      await chownToAccount(ctx, account, docroot, [
        ...result.transferred.map((p) => remoteJoin(docroot, p)),
        ...[...madeDirs].filter((d) => d.startsWith(docroot + '/')),
      ]);
    }
  } finally {
    // Record whatever succeeded, even if the batch was cancelled part-way.
    state.lastPushedAt = new Date().toISOString();
    await writeSiteState(siteDir, state);
  }
  return result;
}

/** Files uploaded as root end up owned by root; give them back to the cPanel account. */
async function chownToAccount(ctx: OperationContext, account: string, docroot: string, paths: string[]): Promise<void> {
  const inside = paths.filter((p) => p.startsWith(docroot + '/'));
  for (let i = 0; i < inside.length; i += 200) {
    const batch = inside.slice(i, i + 200);
    const res = await ctx.shell.exec(`chown -h ${shq(`${account}:${account}`)} -- ${batch.map(shq).join(' ')}`);
    if (res.code !== 0) {
      ctx.logger.warn(`chown failed for some files: ${res.stderr.trim()}`);
    }
  }
}

/** Download the selected server changes and remove files deleted on the server. */
export async function pullFiles(
  ctx: OperationContext,
  siteDir: string,
  paths: readonly string[],
  options: { allowConflicts?: boolean; exclude?: ExcludeOptions } = {},
): Promise<SyncResult> {
  const changes = await computeSiteChanges(ctx, siteDir, options.exclude);
  const { state } = changes;
  const docroot = assertSafeRemoteDir(state.docroot);
  const selected = selectEntries(changes, paths, 'pull', options.allowConflicts ?? false);
  const downloads = selected.filter((e) => e.remote === 'added' || e.remote === 'modified');
  const deletes = selected.filter((e) => e.remote === 'deleted');
  const result: SyncResult = { transferred: [], deleted: [], failed: [] };
  const total = downloads.length + deletes.length;
  let done = 0;
  const tick = (verb: string) => ctx.progress({ phase: 'files', message: `${verb}… (${++done}/${total})`, current: done, total });

  try {
    const down = await mapLimit(
      downloads,
      ctx.concurrency,
      async (e) => {
        state.files[e.path] = await downloadOne(ctx, siteDir, docroot, e.path);
        result.transferred.push(e.path);
        tick('Downloading');
      },
      ctx.signal,
    );
    const del = await mapLimit(
      deletes,
      ctx.concurrency,
      async (e) => {
        await fs.rm(localJoin(siteDir, e.path), { force: true });
        delete state.files[e.path];
        result.deleted.push(e.path);
        tick('Removing');
      },
      ctx.signal,
    );
    for (const r of [...down, ...del]) {
      if (!r.ok) result.failed.push({ path: r.item.path, error: (r.error as Error).message ?? String(r.error) });
    }
  } finally {
    await writeSiteState(siteDir, state);
  }
  return result;
}

/** Download one file via a temp name, then record its baseline entry. */
export async function downloadOne(ctx: OperationContext, siteDir: string, docroot: string, rel: string): Promise<BaselineEntry> {
  const localFile = localJoin(siteDir, rel);
  const remoteFile = remoteJoin(docroot, rel);
  const tmp = `${localFile}.localdock-part`;
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await ctx.sftp.download(remoteFile, tmp);
  await fs.rename(tmp, localFile);
  const [rst, lst, hash] = await Promise.all([ctx.sftp.stat(remoteFile), fs.stat(localFile), sha1File(localFile)]);
  return { hash, size: lst.size, remoteMtime: rst.mtime, localMtimeMs: lst.mtimeMs };
}

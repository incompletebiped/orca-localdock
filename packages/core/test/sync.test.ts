import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeChangeSet, summarize } from '../src/sync/changeSet.js';
import { scanLocal, sha1File } from '../src/sync/localScan.js';
import { hashRemoteFiles, listRemote, reuseBaselineHashes } from '../src/sync/remoteScan.js';
import { readSiteState, writeSiteState, type SiteState } from '../src/sync/state.js';
import { PathMatcher } from '../src/util/glob.js';
import { excludePatterns } from '../src/sync/excludes.js';
import type { ExecResult, RemoteEntry, RemoteFs, RemoteShell } from '../src/ssh/types.js';

const map = (o: Record<string, string>) => new Map(Object.entries(o));

describe('computeChangeSet', () => {
  it('classifies one-sided, two-sided and identical changes', () => {
    const baseline = map({ same: 'h0', localEdit: 'h1', remoteEdit: 'h2', both: 'h3', bothSame: 'h4', localDel: 'h5', remoteDel: 'h6', bothDel: 'h7' });
    const local = map({ same: 'h0', localEdit: 'L1', remoteEdit: 'h2', both: 'L3', bothSame: 'X4', remoteDel: 'h6', newLocal: 'n1', newBoth: 'n2' });
    const remote = map({ same: 'h0', localEdit: 'h1', remoteEdit: 'R2', both: 'R3', bothSame: 'X4', localDel: 'h5', newRemote: 'n3', newBoth: 'n2' });
    const entries = computeChangeSet(baseline, local, remote);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, `${e.direction}:${e.local}/${e.remote}`]));
    expect(byPath).toEqual({
      localEdit: 'push:modified/unchanged',
      remoteEdit: 'pull:unchanged/modified',
      both: 'conflict:modified/modified',
      bothSame: 'same:modified/modified',
      localDel: 'push:deleted/unchanged',
      remoteDel: 'pull:unchanged/deleted',
      bothDel: 'same:deleted/deleted',
      newLocal: 'push:added/unchanged',
      newRemote: 'pull:unchanged/added',
      newBoth: 'same:added/added',
    });
    expect(summarize(entries)).toEqual({ push: 3, pull: 3, conflict: 1, same: 3 });
  });

  it('flags a local edit of a file deleted on the server as a conflict', () => {
    const [e] = computeChangeSet(map({ a: 'h' }), map({ a: 'L' }), map({}));
    expect(e).toMatchObject({ direction: 'conflict', local: 'modified', remote: 'deleted' });
  });
});

describe('scanLocal', () => {
  it('hashes included files and reuses baseline hashes for unchanged ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-scan-'));
    await fs.mkdir(path.join(dir, 'wp-content/themes/x'), { recursive: true });
    await fs.mkdir(path.join(dir, '.localdock'), { recursive: true });
    await fs.writeFile(path.join(dir, 'wp-content/themes/x/style.css'), 'body{}');
    await fs.writeFile(path.join(dir, 'index.php'), '<?php');
    await fs.writeFile(path.join(dir, 'wp-config.php'), 'secret');
    await fs.writeFile(path.join(dir, '.localdock/db.sql'), 'dump');

    const st = await fs.stat(path.join(dir, 'index.php'));
    const files = await scanLocal(dir, new PathMatcher(excludePatterns()), {
      'index.php': { hash: 'from-baseline', size: st.size, remoteMtime: 0, localMtimeMs: st.mtimeMs },
    });
    expect([...files.keys()].sort()).toEqual(['index.php', 'wp-content/themes/x/style.css']);
    expect(files.get('index.php')!.hash).toBe('from-baseline');
    expect(files.get('wp-content/themes/x/style.css')!.hash).toBe(
      await sha1File(path.join(dir, 'wp-content/themes/x/style.css')),
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('remote scanning', () => {
  const tree: Record<string, RemoteEntry[]> = {
    '/home/acct/public_html': [
      { name: 'index.php', isDirectory: false, isFile: true, isSymlink: false, size: 5, mtime: 100 },
      { name: 'wp-config.php', isDirectory: false, isFile: true, isSymlink: false, size: 9, mtime: 100 },
      { name: 'wp-content', isDirectory: true, isFile: false, isSymlink: false, size: 0, mtime: 0 },
      { name: 'link', isDirectory: false, isFile: false, isSymlink: true, size: 0, mtime: 0 },
    ],
    '/home/acct/public_html/wp-content': [
      { name: 'cache', isDirectory: true, isFile: false, isSymlink: false, size: 0, mtime: 0 },
      { name: 'x.php', isDirectory: false, isFile: true, isSymlink: false, size: 3, mtime: 200 },
    ],
  };
  const sftp = {
    readdir: async (d: string) => {
      if (d.endsWith('/cache')) throw new Error('should be pruned');
      return tree[d] ?? [];
    },
  } as unknown as RemoteFs;

  it('lists included files and skips excluded dirs and symlinks', async () => {
    const files = await listRemote(sftp, '/home/acct/public_html/', new PathMatcher(excludePatterns()));
    expect(Object.fromEntries(files)).toEqual({
      'index.php': { size: 5, mtime: 100 },
      'wp-content/x.php': { size: 3, mtime: 200 },
    });
    const missing = reuseBaselineHashes(files, {
      'index.php': { hash: 'aaa', size: 5, remoteMtime: 100, localMtimeMs: 1 },
      'wp-content/x.php': { hash: 'bbb', size: 3, remoteMtime: 150, localMtimeMs: 1 },
    });
    expect(files.get('index.php')!.hash).toBe('aaa');
    expect(missing).toEqual(['wp-content/x.php']);
  });

  it('hashes remote files with quoted paths and one line per file', async () => {
    let command = '';
    const shell: RemoteShell = {
      exec: async (cmd): Promise<ExecResult> => {
        command = cmd;
        return { code: 0, stderr: '', stdout: `${'a'.repeat(40)}\n-\n` };
      },
    };
    const hashes = await hashRemoteFiles(shell, '/home/acct/public_html', ['ok.php', `it's $(evil).php`]);
    expect(command).toContain(`cd '/home/acct/public_html'`);
    expect(command).toContain(`'it'\\''s $(evil).php'`);
    expect(hashes.get('ok.php')).toBe('a'.repeat(40));
    expect(hashes.get(`it's $(evil).php`)).toMatch(/^unreadable:/);
  });

  it('fails loudly when the hash count does not match', async () => {
    const shell: RemoteShell = { exec: async () => ({ code: 0, stderr: '', stdout: 'x\n' }) };
    await expect(hashRemoteFiles(shell, '/home/acct/public_html', ['a', 'b'])).rejects.toThrow(/expected 2/);
  });
});

describe('site state', () => {
  it('round-trips through .localdock/state.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-state-'));
    expect(await readSiteState(dir)).toBeNull();
    const state: SiteState = {
      version: 1,
      hostId: 's1',
      account: 'acct',
      domain: 'example.com',
      docroot: '/home/acct/public_html',
      productionUrl: 'https://example.com',
      tablePrefix: 'wp_',
      pulledAt: '2026-10-08T00:00:00.000Z',
      files: { 'index.php': { hash: 'h', size: 1, remoteMtime: 2, localMtimeMs: 3 } },
    };
    await writeSiteState(dir, state);
    expect(await readSiteState(dir)).toEqual(state);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

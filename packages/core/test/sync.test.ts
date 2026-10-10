import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeChangeSet, summarize } from '../src/sync/changeSet.js';
import { scanLocal, sha1File, updateLocal } from '../src/sync/localScan.js';
import { hashRemoteFiles, listRemoteFiles, reuseBaselineHashes } from '../src/sync/remoteScan.js';
import { readSiteState, writeSiteState, type SiteState } from '../src/sync/state.js';
import { forgetServerDifferences, serverDifferences, writeServerSnapshot } from '../src/sync/serverSnapshot.js';
import { localSiteChanges } from '../src/operations/fileSync.js';
import { PathMatcher } from '../src/util/glob.js';
import { excludePatterns } from '../src/sync/excludes.js';
import type { ExecResult, RemoteShell } from '../src/ssh/types.js';

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
  const Z = String.fromCharCode(0);
  // Newlines and shell characters in names must survive the listing.
  const ODD = 'wp-content/odd\nname $(x).php';
  const listing = [
    ['index.php', '5', '100.7531'],
    ['wp-config.php', '9', '100'],
    ['wp-content/cache/page.html', '4', '100'],
    ['wp-content/x.php', '3', '200.2'],
    [ODD, '1', '300'],
    ['back\\slash.php', '1', '300'],
  ]
    .map((f) => f.join(Z) + Z)
    .join('');

  it('lists the docroot with one find and keeps only included files', async () => {
    let command = '';
    const shell: RemoteShell = {
      exec: async (cmd, opts): Promise<ExecResult> => {
        command = cmd;
        opts!.stdout!.write(Buffer.from(listing));
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const files = await listRemoteFiles(shell, '/home/acct/public_html/', new PathMatcher(excludePatterns()));
    expect(command).toBe(`cd '/home/acct/public_html' && find . -type f -printf '%P\\0%s\\0%T@\\0'`);
    expect(Object.fromEntries(files)).toEqual({
      'index.php': { size: 5, mtime: 100 },
      'wp-content/x.php': { size: 3, mtime: 200 },
      [ODD]: { size: 1, mtime: 300 },
    });
    const missing = reuseBaselineHashes(files, {
      'index.php': { hash: 'aaa', size: 5, remoteMtime: 100, localMtimeMs: 1 },
      'wp-content/x.php': { hash: 'bbb', size: 3, remoteMtime: 150, localMtimeMs: 1 },
    });
    expect(files.get('index.php')!.hash).toBe('aaa');
    expect(missing).toEqual(['wp-content/x.php', ODD]);
  });

  it('fails loudly when find fails', async () => {
    const shell: RemoteShell = { exec: async () => ({ code: 1, stdout: '', stderr: 'find: permission denied' }) };
    await expect(listRemoteFiles(shell, '/home/acct/public_html', new PathMatcher([]))).rejects.toThrow(/permission denied/);
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

describe('updating a local scan', () => {
  it('re-checks only the given files and folders', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-upd-'));
    await fs.mkdir(path.join(dir, 'a'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a/one.php'), '1');
    await fs.writeFile(path.join(dir, 'two.php'), '2');
    const matcher = new PathMatcher(excludePatterns());
    const local = await scanLocal(dir, matcher, {});
    expect([...local.keys()].sort()).toEqual(['a/one.php', 'two.php']);

    await fs.writeFile(path.join(dir, 'two.php'), 'two');
    await fs.mkdir(path.join(dir, 'b/c'), { recursive: true });
    await fs.writeFile(path.join(dir, 'b/c/three.php'), '3');
    await fs.rm(path.join(dir, 'a'), { recursive: true });
    await updateLocal(dir, matcher, {}, ['two.php', 'b', 'a'], local);
    expect([...local.keys()].sort()).toEqual(['b/c/three.php', 'two.php']);
    expect(local.get('two.php')!.hash).toBe(await sha1File(path.join(dir, 'two.php')));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('change list without connecting', () => {
  async function site() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-local-'));
    await fs.mkdir(path.join(dir, 'wp-content/themes/x'), { recursive: true });
    const files: Record<string, string> = { 'index.php': '<?php', 'wp-content/themes/x/style.css': 'body{}', 'wp-content/themes/x/functions.php': '<?php //' };
    const baseline: SiteState['files'] = {};
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      await fs.writeFile(abs, body);
      const st = await fs.stat(abs);
      baseline[rel] = { hash: await sha1File(abs), size: st.size, remoteMtime: 0, localMtimeMs: st.mtimeMs };
    }
    await writeSiteState(dir, {
      version: 1, hostId: 's1', account: 'acct', domain: 'example.com', docroot: '/home/acct/public_html',
      productionUrl: 'https://example.com', tablePrefix: 'wp_', pulledAt: '2026-10-08T00:00:00.000Z', files: baseline,
    });
    return { dir, baseline };
  }

  it('shows local edits straight from disk, with no server check yet', async () => {
    const { dir } = await site();
    await fs.writeFile(path.join(dir, 'wp-content/themes/x/style.css'), 'body{color:red}');
    await fs.writeFile(path.join(dir, 'new.php'), '<?php');
    await fs.rm(path.join(dir, 'index.php'));
    const r = await localSiteChanges(dir);
    expect(r.serverCheckedAt).toBeNull();
    expect(r.entries.map((e) => [e.path, e.local, e.direction])).toEqual([
      ['index.php', 'deleted', 'push'],
      ['new.php', 'added', 'push'],
      ['wp-content/themes/x/style.css', 'modified', 'push'],
    ]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the last server check, and forgets paths once they are pushed or pulled', async () => {
    const { dir, baseline } = await site();
    // The last check saw functions.php edited and index.php deleted on the server.
    const remote = new Map([['wp-content/themes/x/style.css', baseline['wp-content/themes/x/style.css']!.hash], ['wp-content/themes/x/functions.php', 'server-edit']]);
    await writeServerSnapshot(dir, { checkedAt: '2026-10-09T12:00:00.000Z', changed: serverDifferences(baseline, remote) });
    await fs.writeFile(path.join(dir, 'wp-content/themes/x/functions.php'), '<?php // local edit');

    const r = await localSiteChanges(dir);
    expect(r.serverCheckedAt).toBe('2026-10-09T12:00:00.000Z');
    expect(r.entries.map((e) => [e.path, e.direction])).toEqual([
      ['index.php', 'pull'],
      ['wp-content/themes/x/functions.php', 'conflict'],
    ]);

    await forgetServerDifferences(dir, ['index.php']);
    expect((await localSiteChanges(dir)).entries.map((e) => e.path)).toEqual(['wp-content/themes/x/functions.php']);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

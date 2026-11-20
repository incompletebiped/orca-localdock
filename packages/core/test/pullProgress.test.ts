import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearPullProgress, filesLeftToPull, pullProgressPath, readPullProgress, removePartialDownloads, writePullProgress } from '../src/sync/pullProgress.js';
import type { BaselineEntry } from '../src/sync/state.js';

async function project(files: Record<string, string>): Promise<{ dir: string; entry: (rel: string, remoteMtime: number) => Promise<BaselineEntry> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-resume-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  const entry = async (rel: string, remoteMtime: number) => {
    const st = await fs.stat(path.join(dir, rel));
    return { hash: 'h', size: st.size, remoteMtime, localMtimeMs: st.mtimeMs };
  };
  return { dir, entry };
}

describe('resuming a pull', () => {
  it('keeps only files that are unchanged on both sides since they were downloaded', async () => {
    const { dir, entry } = await project({ 'index.php': '<?php', 'a.css': 'a{}', 'edited.js': 'x', 'server-changed.php': 'old', 'gone-locally.txt': 't' });
    const done = {
      'index.php': await entry('index.php', 100),
      'a.css': await entry('a.css', 100),
      'edited.js': await entry('edited.js', 100),
      'server-changed.php': await entry('server-changed.php', 100),
      'gone-locally.txt': await entry('gone-locally.txt', 100),
      'deleted-on-server.php': await entry('index.php', 100),
    };
    await fs.writeFile(path.join(dir, 'edited.js'), 'changed since');
    await fs.rm(path.join(dir, 'gone-locally.txt'));
    const remote = new Map([
      ['index.php', { size: 5, mtime: 100 }],
      ['a.css', { size: 3, mtime: 100 }],
      ['edited.js', { size: 1, mtime: 100 }],
      ['server-changed.php', { size: 3, mtime: 200 }],
      ['gone-locally.txt', { size: 1, mtime: 100 }],
      ['never-downloaded.php', { size: 9, mtime: 100 }],
    ]);
    const { kept, left } = await filesLeftToPull(dir, remote, done);
    expect(Object.keys(kept).sort()).toEqual(['a.css', 'index.php']);
    expect([...left.keys()].sort()).toEqual(['edited.js', 'gone-locally.txt', 'never-downloaded.php', 'server-changed.php']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves, reads and clears the record, and treats an unreadable one as none', async () => {
    const { dir } = await project({});
    expect(await readPullProgress(dir)).toBeNull();
    const progress = { version: 1 as const, domain: 'example.com', startedAt: '2026-01-01T00:00:00.000Z', files: { 'index.php': { hash: 'h', size: 1, remoteMtime: 1, localMtimeMs: 1 } } };
    await writePullProgress(dir, progress);
    expect(await readPullProgress(dir)).toEqual(progress);
    await fs.writeFile(pullProgressPath(dir), '{"version":1,"files":');
    expect(await readPullProgress(dir)).toBeNull();
    await clearPullProgress(dir);
    expect(await readPullProgress(dir)).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes half-written downloads left by a stopped worker', async () => {
    const { dir } = await project({ 'wp-content/plugins/p/p.php.localdock-part': 'half', 'wp-content/plugins/p/p.php': 'whole', 'index.php.localdock-part': 'x' });
    await removePartialDownloads(dir);
    const left = (await fs.readdir(dir, { recursive: true })).map((p) => p.split(path.sep).join('/')).filter((p) => p.endsWith('.php') || p.endsWith('-part'));
    expect(left).toEqual(['wp-content/plugins/p/p.php']);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

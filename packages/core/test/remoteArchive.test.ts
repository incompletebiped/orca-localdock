import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { create } from 'tar';
import { LocalDockError } from '../src/errors.js';
import type { ExecOptions, ExecResult, RemoteShell } from '../src/ssh/types.js';
import { downloadArchive } from '../src/sync/remoteArchive.js';
import type { RemoteFile } from '../src/sync/remoteScan.js';

const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');

/** A gzipped tar of `files`, built like the server's `tar -cz` would. */
async function archive(files: Record<string, string | Buffer>): Promise<Buffer> {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-src-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await fs.writeFile(path.join(src, rel), content);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of create({ gzip: true, cwd: src, portable: true }, Object.keys(files)) as AsyncIterable<Buffer>) chunks.push(chunk);
  await fs.rm(src, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

/** A shell whose tar command streams `data` to stdout, in small chunks like SSH does. */
function streamingShell(data: Buffer, opts: { code?: number; cutAt?: number } = {}) {
  const seen: { command?: string; stdin?: string } = {};
  const shell: RemoteShell = {
    exec: async (command: string, options: ExecOptions = {}): Promise<ExecResult> => {
      seen.command = command;
      seen.stdin = typeof options.stdin === 'string' ? options.stdin : undefined;
      const end = opts.cutAt ?? data.length;
      for (let i = 0; i < end; i += 1000) {
        options.stdout!.write(data.subarray(i, Math.min(i + 1000, end)));
        await new Promise((r) => setImmediate(r));
      }
      if (opts.cutAt !== undefined) throw new LocalDockError('Operation cancelled', 'CANCELLED');
      return { code: opts.code ?? 0, stdout: '', stderr: opts.code ? 'tar: broken' : '' };
    },
  };
  return { shell, seen };
}

const meta = (size: number, mtime = 1000): RemoteFile => ({ size, mtime });

async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.push(path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  }
  return out.sort();
}

describe('downloadArchive', () => {
  it('unpacks the listed files from one stream and records their baseline', async () => {
    const big = Buffer.alloc(300_000, 7);
    const data = await archive({ 'index.php': '<?php', 'wp-content/themes/t/style.css': 'body{}', 'wp-content/big.bin': big, 'wp-config.php': 'secret' });
    const { shell, seen } = streamingShell(data);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-dst-'));
    const wanted = new Map([
      ['index.php', meta(5, 111)],
      ['wp-content/themes/t/style.css', meta(6)],
      ['wp-content/big.bin', meta(big.length)],
      ['gone.php', meta(3)],
    ]);
    const progress: Array<[number, number]> = [];
    const res = await downloadArchive(shell, '/home/acct/public_html/', dir, wanted, { onProgress: (b, t) => progress.push([b, t]) });

    expect(seen.command).toBe(`cd '/home/acct/public_html' && tar -czf - --null --no-recursion --ignore-failed-read -T -`);
    expect(seen.stdin).toBe(['index.php', 'wp-content/themes/t/style.css', 'wp-content/big.bin', 'gone.php'].map((p) => p + '\0').join(''));
    // wp-config.php was in the archive but not asked for, so it isn't written.
    expect(await listAll(dir)).toEqual(['index.php', 'wp-content/big.bin', 'wp-content/themes/t/style.css']);
    expect(res.files['index.php']).toMatchObject({ hash: sha1('<?php'), size: 5, remoteMtime: 111 });
    expect(res.files['wp-content/big.bin']!.hash).toBe(sha1(big));
    expect(res.failed).toEqual([{ path: 'gone.php', error: expect.stringMatching(/Not in the server archive/) }]);
    expect(progress.at(-1)).toEqual([5 + 6 + big.length, 5 + 6 + big.length + 3]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stops cleanly when cancelled mid-stream, leaving no partial files', async () => {
    const big = Buffer.alloc(500_000, 1);
    const data = await archive({ 'a.php': 'aaa', 'b.bin': big });
    const { shell } = streamingShell(data, { cutAt: Math.floor(data.length / 2) });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-dst-'));
    const wanted = new Map([['a.php', meta(3)], ['b.bin', meta(big.length)]]);
    await expect(downloadArchive(shell, '/home/acct/public_html', dir, wanted)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await listAll(dir)).filter((f) => f.endsWith('.localdock-part'))).toEqual([]);
    expect(await listAll(dir)).not.toContain('b.bin');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('fails when the server cannot build the archive', async () => {
    const { shell } = streamingShell(Buffer.alloc(0), { code: 2 });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-dst-'));
    await expect(downloadArchive(shell, '/home/acct/public_html', dir, new Map([['a.php', meta(1)]]))).rejects.toThrow(/exit 2.*tar: broken/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does nothing for an empty list', async () => {
    const shell: RemoteShell = { exec: async () => { throw new Error('should not run'); } };
    expect(await downloadArchive(shell, '/home/acct/public_html', os.tmpdir(), new Map())).toEqual({ files: {}, failed: [] });
  });
});

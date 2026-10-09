import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { dumpRemoteDatabase } from '../src/db/remoteDb.js';
import { Ddev } from '../src/ddev/Ddev.js';
import type { CommandRunner } from '../src/ddev/runner.js';
import type { ExecOptions, ExecResult, RemoteFs, RemoteShell } from '../src/ssh/types.js';

const creds = { name: 'acct_wp', user: 'acct_u', password: 'secret', host: 'localhost', tablePrefix: 'wp_' };
const sftp = { realpath: async () => '/home/acct', writeFile: async () => {}, unlink: async () => {} } as unknown as RemoteFs;
const sql = Array.from({ length: 5000 }, (_, i) => `INSERT INTO wp_posts VALUES (${i},'post ${i}');`).join('\n') + '\n';

/** A server whose mysqldump pipeline streams `body` (gzipped) and exits with `code`. */
function server(body: Buffer, code = 0, estimate = '250000') {
  const commands: string[] = [];
  const shell: RemoteShell = {
    exec: async (cmd: string, options: ExecOptions = {}): Promise<ExecResult> => {
      commands.push(cmd);
      if (cmd.startsWith(`'mysql'`)) return { code: 0, stdout: `${estimate}\n`, stderr: '' };
      if (cmd.startsWith('bash ')) {
        for (let i = 0; i < body.length; i += 512) {
          options.stdout!.write(body.subarray(i, i + 512));
          await new Promise((r) => setImmediate(r));
        }
        return { code, stdout: '', stderr: code ? 'mysqldump: Got error: 1045' : '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { shell, commands };
}

describe('database download', () => {
  it('streams the dump gzipped and unpacks it, reporting bytes against the estimate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-db-'));
    const file = path.join(dir, 'db.sql');
    const { shell, commands } = server(gzipSync(sql));
    const progress: Array<[number, number | undefined]> = [];
    await dumpRemoteDatabase(shell, sftp, creds, file, { onProgress: (b, t) => progress.push([b, t]) });

    expect(await fs.readFile(file, 'utf-8')).toBe(sql);
    const dump = commands.find((c) => c.startsWith('bash '))!;
    expect(dump).toMatch(/^bash -o pipefail -c '.*'mysqldump'.*\| gzip -1'$/);
    expect(dump).not.toContain('secret');
    expect(commands.some((c) => c.includes('information_schema.tables'))).toBe(true);
    expect(progress[0]![1]).toBe(250000);
    expect(progress.at(-1)).toEqual([Buffer.byteLength(sql), Buffer.byteLength(sql)]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('fails on a mysqldump error even though gzip succeeded', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-db-'));
    const { shell } = server(gzipSync('-- partial'), 2);
    await expect(dumpRemoteDatabase(shell, sftp, creds, path.join(dir, 'db.sql'))).rejects.toThrow(/mysqldump failed: mysqldump: Got error: 1045/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('fails on a truncated download', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-db-'));
    const gz = gzipSync(sql);
    const { shell } = server(gz.subarray(0, Math.floor(gz.length / 2)));
    await expect(dumpRemoteDatabase(shell, sftp, creds, path.join(dir, 'db.sql'))).rejects.toThrow(/incomplete/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('database import', () => {
  it('streams the file into ddev import-db on stdin, counting bytes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-db-'));
    const file = path.join(dir, 'db.sql');
    await fs.writeFile(file, sql);
    let args: readonly string[] = [];
    let received = '';
    const runner: CommandRunner = {
      async run(_cmd, a, options) {
        args = a;
        for await (const chunk of options!.stdin!) received += chunk.toString();
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const progress: Array<[number, number | undefined]> = [];
    await new Ddev(runner, { locations: [] }).importDb(dir, file, (b, t) => progress.push([b, t]));
    expect(args).toEqual(['import-db']);
    expect(received).toBe(sql);
    expect(progress.at(-1)).toEqual([Buffer.byteLength(sql), Buffer.byteLength(sql)]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

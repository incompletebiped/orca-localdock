import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTransientFsError, readFileIfExists, retryTransient, writeFileAtomic } from '../src/util/fsRetry.js';
import { readSiteState } from '../src/sync/state.js';

const err = (code: string) => Object.assign(new Error(code), { code });

describe('file access while Windows briefly locks a file', () => {
  it('retries a busy file until it frees up', async () => {
    let calls = 0;
    const value = await retryTransient(async () => {
      if (++calls < 3) throw err('EBUSY');
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('retries EPERM and EACCES only on Windows, and never other errors', async () => {
    expect(isTransientFsError(err('EPERM'), 'win32')).toBe(true);
    expect(isTransientFsError(err('EACCES'), 'win32')).toBe(true);
    expect(isTransientFsError(err('EPERM'), 'linux')).toBe(false);
    expect(isTransientFsError(err('ENOENT'), 'win32')).toBe(false);
    let calls = 0;
    await expect(retryTransient(async () => (calls++, Promise.reject(err('ENOSPC'))))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(calls).toBe(1);
  });

  it('writes atomically without leaving temp files, and reads missing files as null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-fsretry-'));
    const file = path.join(dir, 'state.json');
    expect(await readFileIfExists(file)).toBeNull();
    await Promise.all([writeFileAtomic(file, '{"a":1}'), writeFileAtomic(file, '{"a":2}')]);
    expect(['{"a":1}', '{"a":2}']).toContain(await readFileIfExists(file));
    expect(await fs.readdir(dir)).toEqual(['state.json']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports an unreadable state file instead of calling the folder "no site"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-fsretry-'));
    expect(await readSiteState(dir)).toBeNull();
    await fs.mkdir(path.join(dir, '.localdock', 'state.json'), { recursive: true }); // a directory where the file should be
    await expect(readSiteState(dir)).rejects.toMatchObject({ code: 'EISDIR' });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

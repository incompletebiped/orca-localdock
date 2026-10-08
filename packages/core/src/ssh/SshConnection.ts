import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { Client, type ConnectConfig, type SFTPWrapper, type FileEntryWithStats, type Stats } from 'ssh2';
import { LocalDockError, normalizeError } from '../errors.js';
import { silentLogger, registerSecret, type Logger } from '../log.js';
import type { ExecOptions, ExecResult, RemoteEntry, RemoteFs, RemoteShell, RemoteStat, SshTarget } from './types.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** OpenSSH-style fingerprint of a raw host key: `SHA256:<base64, no padding>`. */
export function fingerprintHostKey(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function defaultAgent(): string | undefined {
  if (process.env['SSH_AUTH_SOCK']) {
    return process.env['SSH_AUTH_SOCK'];
  }
  return process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}

export interface ConnectOptions {
  /**
   * Accept a host key when none is pinned yet. The UI should only set this
   * after showing the fingerprint (from a HOST_KEY_UNKNOWN error) to the user.
   */
  acceptHostKey?: string;
  readyTimeoutMs?: number;
  logger?: Logger;
}

/**
 * One SSH connection, with lazily opened SFTP. Host keys are verified
 * against the pinned fingerprint. With nothing pinned, the connection is
 * refused with HOST_KEY_UNKNOWN (carrying the fingerprint) unless the caller
 * passes it back as `acceptHostKey`.
 */
export class SshConnection implements RemoteShell {
  private sftpSession: SFTPWrapper | undefined;
  private constructor(
    private readonly client: Client,
    readonly target: SshTarget,
    readonly hostKeyFingerprint: string,
    private readonly log: Logger,
  ) {}

  static async connect(target: SshTarget, options: ConnectOptions = {}): Promise<SshConnection> {
    const log = (options.logger ?? silentLogger).child('ssh');
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: options.readyTimeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
    };

    switch (target.auth.kind) {
      case 'agent': {
        const agent = defaultAgent();
        if (!agent) {
          throw new LocalDockError('No SSH agent found (SSH_AUTH_SOCK is not set)', 'AUTH_FAILED');
        }
        config.agent = agent;
        break;
      }
      case 'key':
        // Read at connect time only. The key never leaves this process's memory.
        config.privateKey = await fs.readFile(target.auth.keyPath);
        if (target.auth.passphrase) {
          registerSecret(target.auth.passphrase);
          config.passphrase = target.auth.passphrase;
        }
        break;
      case 'password':
        registerSecret(target.auth.password);
        config.password = target.auth.password;
        break;
    }

    let seen: string | undefined;
    config.hostVerifier = (key: Buffer) => {
      seen = fingerprintHostKey(key);
      if (target.hostKeyFingerprint) {
        return seen === target.hostKeyFingerprint;
      }
      return options.acceptHostKey !== undefined && seen === options.acceptHostKey;
    };

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (err) => {
        if (seen && target.hostKeyFingerprint && seen !== target.hostKeyFingerprint) {
          reject(
            new LocalDockError(
              `The SSH host key for ${target.host} has changed (expected ${target.hostKeyFingerprint}, got ${seen}). ` +
                'This happens when a server is reinstalled or migrated, but it can also mean the connection is being ' +
                'intercepted. Verify the new key with your host before trusting it.',
              'HOST_KEY_MISMATCH',
              true,
            ),
          );
        } else if (seen && !target.hostKeyFingerprint && options.acceptHostKey !== seen) {
          const e = new LocalDockError(
            `Unknown SSH host key for ${target.host}: ${seen}. Confirm this fingerprint to trust the server.`,
            'HOST_KEY_UNKNOWN',
            true,
          );
          (e as LocalDockError & { fingerprint?: string }).fingerprint = seen;
          reject(e);
        } else {
          reject(normalizeError(err));
        }
      });
      client.connect(config);
    });

    log.info(`Connected to ${target.username}@${target.host}:${target.port}`);
    return new SshConnection(client, target, seen!, log);
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          reject(normalizeError(err));
          return;
        }
        let stdout = '';
        let stderr = '';
        const onAbort = () => {
          stream.signal('TERM');
          stream.close();
          reject(new LocalDockError('Operation cancelled', 'CANCELLED'));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        if (options.stdout) {
          stream.pipe(options.stdout, { end: false });
        } else {
          stream.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
        }
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
        stream.on('error', (e: Error) => reject(normalizeError(e)));
        stream.on('close', (code: number | null) => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve({ stdout, stderr, code: code ?? 0 });
        });

        if (options.stdin !== undefined) {
          const input = typeof options.stdin === 'string' ? Readable.from([options.stdin]) : options.stdin;
          input.on('error', (e) => reject(normalizeError(e)));
          input.pipe(stream);
        } else {
          stream.end();
        }
      });
    });
  }

  /** Run a command and throw REMOTE_COMMAND_FAILED on a non-zero exit. */
  async run(command: string, what: string, options?: ExecOptions): Promise<ExecResult> {
    const result = await this.exec(command, options);
    if (result.code !== 0) {
      throw new LocalDockError(
        `${what} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
        'REMOTE_COMMAND_FAILED',
      );
    }
    return result;
  }

  async sftp(): Promise<RemoteFs> {
    if (!this.sftpSession) {
      this.sftpSession = await new Promise<SFTPWrapper>((resolve, reject) =>
        this.client.sftp((err, s) => (err ? reject(normalizeError(err)) : resolve(s))),
      );
    }
    return new SftpFs(this.sftpSession);
  }

  close(): void {
    this.sftpSession?.end();
    this.client.end();
    this.log.debug(`Disconnected from ${this.target.host}`);
  }
}

function toStat(attrs: Stats): RemoteStat {
  const type = (attrs.mode ?? 0) & S_IFMT;
  return {
    isDirectory: type === S_IFDIR,
    isFile: type === S_IFREG,
    size: attrs.size,
    mtime: attrs.mtime,
    uid: attrs.uid,
    gid: attrs.gid,
  };
}

class SftpFs implements RemoteFs {
  constructor(private readonly s: SFTPWrapper) {}

  private call<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) =>
      fn((err, value) => (err ? reject(normalizeError(err)) : resolve(value as T))),
    );
  }

  async readdir(dir: string): Promise<RemoteEntry[]> {
    const list = await this.call<FileEntryWithStats[]>((cb) => this.s.readdir(dir, cb));
    return list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => {
        const type = (e.attrs.mode ?? 0) & S_IFMT;
        return {
          name: e.filename,
          isDirectory: type === S_IFDIR,
          isFile: type === S_IFREG,
          isSymlink: type === S_IFLNK,
          size: e.attrs.size,
          mtime: e.attrs.mtime,
        };
      });
  }

  async stat(p: string): Promise<RemoteStat> {
    return toStat(await this.call<Stats>((cb) => this.s.lstat(p, cb)));
  }

  async readFile(p: string, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
    const st = await this.stat(p);
    if (st.size > maxBytes) {
      throw new LocalDockError(`${p} is larger than ${maxBytes} bytes`, 'UNSAFE_INPUT');
    }
    return this.call<Buffer>((cb) => this.s.readFile(p, cb));
  }

  writeFile(p: string, data: string | Buffer, mode = 0o600): Promise<void> {
    return this.call<void>((cb) => this.s.writeFile(p, data, { mode }, (err) => cb(err)));
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await this.call<void>((cb) => this.s.fastGet(remotePath, localPath, (err) => cb(err)));
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    // Always 0644, the WordPress norm. Local modes are meaningless on Windows
    // (files report 0666) and must never make server files world-writable.
    await this.call<void>((cb) => this.s.fastPut(localPath, remotePath, { mode: 0o644 }, (err) => cb(err)));
  }

  async unlink(p: string): Promise<void> {
    try {
      await this.call<void>((cb) => this.s.unlink(p, (err) => cb(err)));
    } catch (err) {
      // Already gone is fine.
      if (!/No such file/i.test(String((err as Error).message))) {
        throw err;
      }
    }
  }

  async mkdirp(dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      try {
        const st = await this.stat(current);
        if (!st.isDirectory) {
          throw new LocalDockError(`${current} exists and is not a directory`, 'REMOTE_COMMAND_FAILED');
        }
      } catch (err) {
        if (err instanceof LocalDockError && err.code === 'REMOTE_COMMAND_FAILED') {
          throw err;
        }
        await this.call<void>((cb) => this.s.mkdir(current, (e) => cb(e)));
      }
    }
  }

  realpath(p: string): Promise<string> {
    return this.call<string>((cb) => this.s.realpath(p, cb));
  }
}

/** Stream a local file into a Readable (helper for ExecOptions.stdin). */
export function fileStream(localPath: string): Readable {
  return fsSync.createReadStream(localPath);
}

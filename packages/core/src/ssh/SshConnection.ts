import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { Client, type ConnectConfig, type SFTPWrapper, type FileEntryWithStats, type Stats } from 'ssh2';
import { LocalDockError, normalizeError } from '../errors.js';
import { silentLogger, registerSecret, type Logger } from '../log.js';
import type { ExecOptions, ExecResult, RemoteEntry, RemoteFs, RemoteShell, RemoteStat, SshTarget } from './types.js';

/** Command output LocalDock keeps in memory, per stream. */
const MAX_BUFFERED_OUTPUT = 64 * 1024 * 1024;

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
  private ended = false;
  /** Calls still waiting on the server; a dropped connection fails them all (ssh2 leaves SFTP calls waiting forever). */
  private readonly waiting = new Set<(err: Error) => void>();
  private constructor(
    private readonly client: Client,
    readonly target: SshTarget,
    readonly hostKeyFingerprint: string,
    private readonly log: Logger,
  ) {
    // A connection that drops later (network change, server restart, idle timeout) must not
    // crash the process with an unhandled 'error', and callers need to know to reconnect.
    client.on('error', (err) => log.warn(`Connection to ${target.host}: ${err.message}`));
    client.on('close', () => {
      this.ended = true;
      this.sftpSession = undefined;
      const lost = this.lostError();
      for (const fail of this.waiting) fail(lost);
      this.waiting.clear();
    });
  }

  private lostError(): LocalDockError {
    return new LocalDockError(`The connection to ${this.target.host} dropped. Try again.`, 'SSH_TIMEOUT', true);
  }

  /** A promise for one call on this connection that fails, rather than waits forever, if the connection drops. */
  private call<T>(run: (resolve: (value: T) => void, reject: (err: Error) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.ended) {
        reject(this.lostError());
        return;
      }
      const fail = (err: Error) => reject(err);
      this.waiting.add(fail);
      run(
        (value) => {
          this.waiting.delete(fail);
          resolve(value);
        },
        (err) => {
          this.waiting.delete(fail);
          reject(err);
        },
      );
    });
  }

  /** True once the connection has dropped or been closed; open a new one. */
  get closed(): boolean {
    return this.ended;
  }

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
      case 'keys-then-agent': {
        const keys = await Promise.all(target.auth.keyPaths.map((p) => fs.readFile(p).catch(() => null)));
        const agent = defaultAgent();
        if (agent) config.agent = agent;
        const queue: Array<Record<string, unknown>> = [
          ...keys.filter((k) => k !== null).map((key) => ({ type: 'publickey', username: target.username, key })),
          ...(agent ? [{ type: 'agent', username: target.username, agent }] : []),
        ];
        if (queue.length === 0) throw new LocalDockError('No SSH key or agent to log in with', 'AUTH_FAILED');
        // ssh2 skips keys it can't use without a passphrase and moves on, as ssh does in batch mode.
        config.authHandler = (_methodsLeft, _partial, next) => next((queue.shift() ?? false) as never);
        break;
      }
    }

    let seen: string | undefined;
    config.hostVerifier = (key: Buffer) => {
      seen = fingerprintHostKey(key);
      if (target.knownHostKeys) {
        return target.knownHostKeys.includes(seen);
      }
      if (target.hostKeyFingerprint) {
        return seen === target.hostKeyFingerprint;
      }
      return options.acceptHostKey !== undefined && seen === options.acceptHostKey;
    };

    const client = new Client();
    const connecting = new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      // `on`, not `once`: ssh2 can emit more than one error while a login fails (one per auth
      // method), and an 'error' with no listener is thrown as an uncaught exception.
      client.on('error', (err) => {
        if (seen && target.knownHostKeys && !target.knownHostKeys.includes(seen)) {
          const how = target.trustCommand ? `Connect once with "${target.trustCommand}" in a terminal` : 'Connect once with ssh in a terminal';
          reject(
            target.knownHostKeys.length === 0
              ? new LocalDockError(
                  `${target.host} isn't in your known_hosts yet. ${how} to check and trust its key, then try again.`,
                  'HOST_KEY_UNKNOWN',
                  true,
                )
              : new LocalDockError(
                  `The SSH host key for ${target.host} doesn't match your known_hosts (got ${seen}). This happens when a server is ` +
                    'reinstalled or migrated, but it can also mean the connection is being intercepted. Check with your host, ' +
                    `then fix the entry (${how.toLowerCase()} to see ssh's own warning).`,
                  'HOST_KEY_MISMATCH',
                  true,
                ),
          );
        } else if (seen && target.hostKeyFingerprint && seen !== target.hostKeyFingerprint) {
          reject(
            new LocalDockError(
              `The SSH host key for ${target.host} has changed (expected ${target.hostKeyFingerprint}, got ${seen}). ` +
                'This happens when a server is reinstalled or migrated, but it can also mean the connection is being ' +
                'intercepted. Verify the new key with your host before trusting it.',
              'HOST_KEY_MISMATCH',
              true,
            ),
          );
        } else if (seen && !target.knownHostKeys && !target.hostKeyFingerprint && options.acceptHostKey !== seen) {
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
    try {
      await connecting;
    } catch (err) {
      // Don't leave a half-open socket behind; the 'error' listener stays for anything it still emits.
      client.end();
      throw err;
    }

    client.removeAllListeners('error');
    log.info(`Connected to ${target.username}@${target.host}:${target.port}`);
    return new SshConnection(client, target, seen!, log);
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.call((resolve, reject) => {
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

        // Output held in memory is capped, so a hostile or broken server can't exhaust it.
        const tooMuch = (what: string) => {
          stream.close();
          reject(new LocalDockError(`The server sent more ${what} than LocalDock accepts`, 'REMOTE_COMMAND_FAILED'));
        };
        if (options.stdout) {
          stream.pipe(options.stdout, { end: false });
          // A destination that gives up (e.g. it hit its own limit) ends the command instead of stalling it.
          options.stdout.once('error', (e) => {
            stream.close();
            reject(e instanceof LocalDockError ? e : normalizeError(e));
          });
        } else {
          stream.on('data', (d: Buffer) => {
            stdout += d.toString('utf-8');
            if (stdout.length > MAX_BUFFERED_OUTPUT) tooMuch('output');
          });
        }
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf-8');
          if (stderr.length > MAX_BUFFERED_OUTPUT) tooMuch('error output');
        });
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
      this.sftpSession = await this.call<SFTPWrapper>((resolve, reject) =>
        this.client.sftp((err, s) => (err ? reject(normalizeError(err)) : resolve(s))),
      );
    }
    return new SftpFs(this.sftpSession, (run) => this.call(run));
  }

  close(): void {
    this.ended = true;
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
  constructor(
    private readonly s: SFTPWrapper,
    private readonly onConnection: <T>(run: (resolve: (value: T) => void, reject: (err: Error) => void) => void) => Promise<T>,
  ) {}

  private call<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    return this.onConnection<T>((resolve, reject) =>
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
    // A regular file only: a symlink could lead a root session to another account's (or the system's)
    // files, and a device like /dev/zero has no size to check.
    if (!st.isFile) {
      throw new LocalDockError(`${p} is not a regular file`, 'UNSAFE_INPUT');
    }
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

  /**
   * Upload to a temporary name next to the file, then rename it into place. A symlink at the target is
   * replaced instead of followed, so a root session never writes through a link a cPanel user planted.
   */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const tmp = `${remotePath}.localdock-${randomBytes(6).toString('hex')}.tmp`;
    // Always 0644, the WordPress norm. Local modes are meaningless on Windows
    // (files report 0666) and must never make server files world-writable.
    await this.call<void>((cb) => this.s.fastPut(localPath, tmp, { mode: 0o644 }, (err) => cb(err)));
    try {
      await this.call<void>((cb) => this.s.ext_openssh_rename(tmp, remotePath, (err) => cb(err)));
    } catch (err) {
      await this.call<void>((cb) => this.s.unlink(tmp, (e) => cb(e))).catch(() => {});
      throw err;
    }
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

import type { Readable, Writable } from 'node:stream';

export type SshAuth =
  | { kind: 'agent' }
  | { kind: 'key'; keyPath: string; passphrase?: string }
  | { kind: 'password'; password: string };

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** Pinned host key fingerprint (`SHA256:…`, as printed by `ssh-keygen -lf`). */
  hostKeyFingerprint?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  /** Data written to the command's stdin, then stdin is closed. */
  stdin?: Readable | string;
  /** Pipe stdout here instead of buffering it (stdout in the result will be empty). */
  stdout?: Writable;
  signal?: AbortSignal;
}

/** Runs commands on the remote host. Implemented by SshConnection; mocked in tests. */
export interface RemoteShell {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface RemoteEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

export interface RemoteStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: number;
  uid: number;
  gid: number;
}

/** File operations on the remote host (SFTP). Mocked in tests. */
export interface RemoteFs {
  readdir(dir: string): Promise<RemoteEntry[]>;
  stat(p: string): Promise<RemoteStat>;
  readFile(p: string, maxBytes?: number): Promise<Buffer>;
  /** Write a small file with the given mode. Used for private temp files. */
  writeFile(p: string, data: string | Buffer, mode?: number): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  upload(localPath: string, remotePath: string): Promise<void>;
  unlink(p: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  realpath(p: string): Promise<string>;
}

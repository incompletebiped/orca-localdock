import type { RemoteFs, RemoteShell } from '@localdock/core';

/** The `orca` object Orca passes to a plugin worker's activate(). Typed from Orca 1.4.222's hello-orca example. */
export interface OrcaWorkerApi {
  commands: { register(id: string, handler: (args?: unknown) => unknown): void };
  events: { on(event: string, handler: (payload: unknown) => unknown): void };
  host: { call(method: string, params?: unknown): Promise<unknown> };
  log(message: string): void;
  grantedCapabilities?: readonly string[];
}

export interface ProjectInfo {
  /** Absolute path of the project's folder on this machine. */
  path: string;
  name: string;
}

export interface SshHostInfo {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
}

/** An SSH session to a host: command execution plus file transfer. */
export interface RemoteSession {
  shell: RemoteShell;
  sftp: RemoteFs;
  close(): void;
}

/**
 * Everything LocalDock asks of Orca. Methods marked GAP have no Orca API in
 * 1.4.222 and throw OrcaApiPendingError in the public build. A private fork
 * can implement them with workarounds without touching anything else.
 */
export interface OrcaHost {
  /** GAP project-path: the folder of the project currently open in Orca. */
  activeProject(): Promise<ProjectInfo | null>;
  /** GAP ssh-hosts: SSH hosts configured in Orca (Settings → SSH). */
  listSshHosts(): Promise<SshHostInfo[]>;
  /** GAP ssh-hosts: ask Orca to connect to a host (it handles keys, passphrases and host-key prompts). */
  connectSshHost(hostId: string): Promise<void>;
  /** GAP ssh-session: run commands and transfer files over Orca's connection to a host. */
  openSession(hostId: string): Promise<RemoteSession>;
  /** GAP open-url: open a URL in an Orca browser tab. */
  openUrl(url: string): Promise<void>;

  /** Available: desktop notification. */
  notify(title: string, body?: string): Promise<void>;
  /** Available: plugin-private key/value storage. */
  storageGet<T>(key: string): Promise<T | undefined>;
  storageSet(key: string, value: unknown): Promise<void>;
  log(message: string): void;
}

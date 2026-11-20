import type { RemoteFs, RemoteShell } from '@localdock/core';

interface Disposable {
  dispose(): void;
}

/**
 * The part of the `orca` object Orca passes to a plugin worker's activate()
 * that LocalDock uses (host API 1). `orca plugin types` writes the full typings.
 */
export interface OrcaWorkerApi {
  commands: { register(id: string, handler: (args?: unknown) => unknown): Disposable | void };
  events: { on(event: string, handler: (payload: unknown) => unknown): Disposable | void };
  panels: {
    /** Answer a panel's `plugin.request(name, input)`. */
    handle(name: string, handler: (input: unknown) => unknown): Disposable | void;
    /** Push to every open panel of this plugin. Fire and forget: at most 256 KiB, 200 posts per 10 s. */
    post(event: string, payload: unknown): void;
  };
  host: { call(method: string, params?: unknown): Promise<unknown>; has?(method: string): boolean };
  log(message: string): void;
  grantedCapabilities?: readonly string[];
}

export interface ProjectInfo {
  /** Absolute path of the project's folder (on this machine unless `remote`). */
  path: string;
  name: string;
  /** The project lives on an SSH host or another Orca, so DDEV can't run it here. */
  remote?: boolean;
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
  /** True once the connection dropped; the controller then opens a new one. */
  readonly closed?: boolean;
}

/** What the Orca status bar item shows; null hides it. */
export interface StatusItem {
  text: string;
  tooltip: string;
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

/**
 * Everything LocalDock asks of its surroundings: Orca's plugin API, plus SSH
 * (the user's own ssh config, since Orca doesn't share its SSH hosts with
 * plugins). A fork can swap any of it without touching anything else.
 */
export interface OrcaHost {
  /** The project focused in Orca, or null when none is. */
  activeProject(): Promise<ProjectInfo | null>;
  /** SSH hosts LocalDock can use. */
  listSshHosts(): Promise<SshHostInfo[]>;
  /** One host by id, including ids saved by older versions; defaults to searching listSshHosts(). */
  findSshHost?(hostId: string): Promise<SshHostInfo | null>;
  /** Make sure a host is reachable before using it (a no-op when LocalDock connects by itself). */
  connectSshHost(hostId: string): Promise<void>;
  /** Run commands and transfer files on a host. */
  openSession(hostId: string): Promise<RemoteSession>;

  /** Open a URL in a tab of Orca's own browser, in the given project. False when that isn't possible here. */
  openInOrcaBrowser(url: string, projectDir: string): Promise<boolean>;
  /** Desktop notification. */
  notify(title: string, body?: string): Promise<void>;
  /** Show (or with null, hide) LocalDock's status bar item. */
  setStatus(item: StatusItem | null): Promise<void>;
  /** Plugin-private key/value storage. */
  storageGet<T>(key: string): Promise<T | undefined>;
  storageSet(key: string, value: unknown): Promise<void>;
  log(message: string): void;
}

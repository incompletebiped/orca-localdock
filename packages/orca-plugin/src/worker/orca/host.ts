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
}

/** What the Orca status bar item shows; null hides it. */
export interface StatusItem {
  text: string;
  tooltip: string;
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

/**
 * Everything LocalDock asks of Orca. Methods marked GAP have no Orca API yet
 * and throw OrcaApiPendingError in the public build. A private fork can
 * implement them with workarounds without touching anything else.
 */
export interface OrcaHost {
  /** The project focused in Orca, or null when none is. */
  activeProject(): Promise<ProjectInfo | null>;
  /** GAP ssh-hosts: SSH hosts configured in Orca (Settings → SSH). */
  listSshHosts(): Promise<SshHostInfo[]>;
  /** GAP ssh-hosts: ask Orca to connect to a host (it handles keys, passphrases and host-key prompts). */
  connectSshHost(hostId: string): Promise<void>;
  /** GAP ssh-session: run commands and transfer files over Orca's connection to a host. */
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

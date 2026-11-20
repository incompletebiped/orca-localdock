import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LocalDockError,
  connectSshAlias,
  listSshConfigAliases,
  processRunner,
  resolveSshHost,
  type CommandRunner,
  type SshConnection,
} from '@localdock/core';
import type { OrcaHost, OrcaWorkerApi, ProjectInfo, RemoteSession, SshHostInfo, StatusItem } from './host.js';

interface WorkspaceContext {
  workspaceId?: string;
  displayName: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  project?: string | null;
  path: string;
  hostId: string | null;
}

/** Orca's CLI launcher next to the app the worker runs in (the worker's Node is Orca's own executable). */
function orcaCliCandidates(execPath = process.execPath, platform = process.platform): string[] {
  const dir = path.dirname(execPath);
  if (platform === 'win32') return [path.join(dir, 'resources', 'bin', 'orca.exe')];
  if (platform === 'darwin') return [path.join(dir, '..', 'Resources', 'bin', 'orca')];
  return [path.join(dir, 'resources', 'bin', 'orca')];
}

/**
 * The CLI finds the running Orca through %APPDATA% on Windows, which a plugin
 * worker's trimmed environment may not carry.
 */
function orcaCliEnv(env = process.env, platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'win32' || env['APPDATA']) return env;
  return { ...env, APPDATA: path.join(os.homedir(), 'AppData', 'Roaming') };
}

/** The status bar item declared in orca-plugin.json. */
const STATUS_ITEM_ID = 'site';

/**
 * OrcaHost backed by Orca's plugin host API 1, plus SSH through the user's own
 * ssh config (Orca has no plugin API for its SSH hosts yet). When Orca adds
 * one, swap the SSH methods here (see docs/ORCA-GAPS.md).
 */
export class PluginOrcaHost implements OrcaHost {
  constructor(
    private readonly orca: OrcaWorkerApi,
    private readonly runner: CommandRunner = processRunner,
    /** Where to look for Orca's CLI launcher; the first that exists wins, then `orca` on PATH. */
    private readonly cliCandidates: string[] = orcaCliCandidates(),
    private readonly ssh: {
      aliases: () => Promise<string[]>;
      connect: (alias: string) => Promise<SshConnection>;
    } = { aliases: () => listSshConfigAliases(), connect: (alias) => connectSshAlias(alias, { runner }) },
  ) {}

  /**
   * Plugins have no host API for Orca's browser yet, so this asks Orca's own
   * CLI (`orca tab create`), which talks to the running Orca the same way.
   * It's spawned directly, never through a shell.
   */
  async openInOrcaBrowser(url: string, projectDir: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(url)) return false;
    const cli = this.cliCandidates.find((c) => existsSync(c)) ?? 'orca';
    const args = ['tab', 'create', '--url', url, '--worktree', `path:${projectDir}`, '--json'];
    const r = await this.runner.run(cli, args, { env: orcaCliEnv() });
    if (r.code !== 0) this.log(`Opening ${url} in Orca's browser failed: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? `exit ${r.code}`}`);
    return r.code === 0;
  }

  async activeProject(): Promise<ProjectInfo | null> {
    // readContext names the focused workspace; workspace.list has its folder.
    const ctx = (await this.orca.host.call('workspace.readContext')) as WorkspaceContext | null;
    if (!ctx?.workspaceId) return null;
    const { workspaces } = (await this.orca.host.call('workspace.list')) as { workspaces: WorkspaceRow[] };
    const ws = workspaces.find((w) => w.id === ctx.workspaceId);
    if (!ws) return null;
    const name = ws.project ?? ws.name;
    // `local` is this machine; null is a folder recorded without a host, also here. Anything else is remote.
    if (ws.hostId !== null && ws.hostId !== 'local') return { path: ws.path, name, remote: true };
    return { path: path.resolve(ws.path), name };
  }

  /**
   * The Host aliases in the user's ~/.ssh/config. Orca doesn't share its SSH
   * hosts or connections with plugins, so LocalDock uses what `ssh` uses:
   * the same config, keys, agent and known_hosts.
   */
  async listSshHosts(): Promise<SshHostInfo[]> {
    const aliases = await this.ssh.aliases();
    const hosts = await Promise.all(
      aliases.map(async (alias) => {
        try {
          const h = await resolveSshHost(alias, this.runner);
          return { id: alias, label: alias, host: h.hostname, port: h.port, username: h.user, connected: true };
        } catch (err) {
          this.log(`SSH host ${alias}: ${(err as Error).message}`);
          return null;
        }
      }),
    );
    return hosts.filter((h): h is SshHostInfo => h !== null);
  }

  /** A host by alias, or by the Orca SSH host id older versions saved, when an alias has that host's name. */
  async findSshHost(hostId: string): Promise<SshHostInfo | null> {
    const hosts = await this.listSshHosts();
    const direct = hosts.find((h) => h.id === hostId);
    if (direct) return direct;
    const name = await this.orcaHostName(hostId);
    return (name && hosts.find((h) => h.id === name)) || null;
  }

  async connectSshHost(_hostId: string): Promise<void> {}

  async openSession(hostId: string): Promise<RemoteSession> {
    const host = await this.findSshHost(hostId);
    if (!host) throw new LocalDockError(`No SSH host "${hostId}" in your SSH config (~/.ssh/config).`, 'NOT_FOUND', false);
    const conn = await this.ssh.connect(host.id);
    const sftp = await conn.sftp();
    return {
      shell: conn,
      sftp,
      close: () => conn.close(),
      get closed() {
        return conn.closed;
      },
    };
  }

  /** The name Orca shows for one of its SSH hosts (`orca host list`), or null. */
  private async orcaHostName(hostId: string): Promise<string | null> {
    if (!/^ssh-[\w-]+$/.test(hostId)) return null;
    const cli = this.cliCandidates.find((c) => existsSync(c)) ?? 'orca';
    const r = await this.runner.run(cli, ['host', 'list', '--json'], { env: orcaCliEnv() }).catch(() => null);
    if (!r || r.code !== 0) return null;
    try {
      const hosts = (JSON.parse(r.stdout) as { result?: { hosts?: Array<{ id?: string; name?: string }> } }).result?.hosts ?? [];
      return hosts.find((h) => h.id === hostId)?.name ?? null;
    } catch {
      return null;
    }
  }

  async notify(title: string, body?: string): Promise<void> {
    await this.orca.host.call('notifications.show', { title: title.slice(0, 120), ...(body ? { body: body.slice(0, 1000) } : {}) });
  }

  async setStatus(item: StatusItem | null): Promise<void> {
    await this.orca.host.call('statusBar.update', item ? { id: STATUS_ITEM_ID, visible: true, ...item } : { id: STATUS_ITEM_ID, visible: false });
  }

  async storageGet<T>(key: string): Promise<T | undefined> {
    const r = (await this.orca.host.call('storage.get', { key })) as { value?: T | null } | undefined;
    return r?.value ?? undefined;
  }

  async storageSet(key: string, value: unknown): Promise<void> {
    await this.orca.host.call('storage.set', { key, value });
  }

  log(message: string): void {
    this.orca.log(message);
  }
}

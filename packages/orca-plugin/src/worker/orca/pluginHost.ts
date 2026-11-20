import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { processRunner, type CommandRunner } from '@localdock/core';
import { OrcaApiPendingError } from '../../shared/gaps.js';
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
 * OrcaHost backed by Orca's plugin host API 1. Implements what the API offers
 * and throws OrcaApiPendingError for the rest. When Orca adds a capability,
 * fill in the matching method here (and drop the gap from docs/ORCA-GAPS.md).
 */
export class PluginOrcaHost implements OrcaHost {
  constructor(
    private readonly orca: OrcaWorkerApi,
    private readonly runner: CommandRunner = processRunner,
    /** Where to look for Orca's CLI launcher; the first that exists wins, then `orca` on PATH. */
    private readonly cliCandidates: string[] = orcaCliCandidates(),
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

  async listSshHosts(): Promise<SshHostInfo[]> {
    throw new OrcaApiPendingError('ssh-hosts');
  }

  async connectSshHost(_hostId: string): Promise<void> {
    throw new OrcaApiPendingError('ssh-hosts');
  }

  async openSession(_hostId: string): Promise<RemoteSession> {
    throw new OrcaApiPendingError('ssh-session');
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
